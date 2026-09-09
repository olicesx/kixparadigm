// dsh-vision-bridge — client 半（v2 提交时转换模式）：composer dock 插件。
//
// v2 语义（2026-08 用户确认实现）：
//   - 粘贴/拖入图片 → 图片正常停留在输入框，不打断输入（与 v1 粘贴即转不同）；
//   - 点发送时重读 sessionId 对应模型目录；本地 capabilities 仅查询精确身份元数据。
//     只有当前 ready 代次明确无视觉才调 describe；有视觉/未知直接交宿主：
//       describe：描述写入 draft（`📷 [图片自动识别]` 前缀）+ 图片 chips 移除 → 再真正提交；
//       keep    ：原样提交（图片保留，模型自己看图）；
//   - 转换失败 / 超时（client 100s）→ 提示且不提交，图片保留可重试；
//   - 仅转描述路径：单图 >8MB → 快速失败提示（不发起请求，不提交）。
//
// 实现要点：
//   - 包装 props.inputActions.submit（InputActions 公开面，stable identity），
//     `__visionWrapped` 防重复包装；stateRef 读最新 imageIds/draft（包装闭包不持旧值）；
//   - 使用 dock 的 sessionId；缺身份/服务时走原生，图片 File 经 conversation.draftImages(ids) 取；
//   - 转换期间 busyRef 拦重复提交（提示不二次转换）。
//
// 已知边界：键盘 Enter 提交走 ComposerKeyboard（InputBar 内部面），不经
// inputActions.submit，不触发本转换——v2 仅覆盖"点发送"路径（README 实测同路径）。

window.__ModuleLoader__.load({
	id: "dsh-vision-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		/** File → base64（data URL 的逗号后部分）。 */
		function fileToBase64(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const url = String(reader.result || "");
					resolve(url.slice(url.indexOf(",") + 1));
				};
				reader.onerror = () => reject(reader.error || new Error("read failed"));
				reader.readAsDataURL(file);
			});
		}

		/** 单图大小上限：超过则快速失败（README 规格）。 */
		const MAX_SINGLE_IMAGE_BYTES = 8 * 1024 * 1024;
		/** client fetch 超时：README 规格 100s。 */
		const CLIENT_TIMEOUT_MS = 100000;

		/**
		 * dock 组件工厂：闭包捕获 client root ctx（apply 时已注入
		 * slots/conversation 等 client 服务）。
		 */
		function makeVisionDock(ctx) {
			return function VisionDock(props) {
				const sessionId = props?.sessionId ?? null;
				let directory = null;
				try {
					if (sessionId) directory = ctx.get("modelDirectories")?.directoryFor(sessionId) ?? null;
				} catch { /* Missing session services leave submission to the host. */ }
				const input = props?.input ?? null;
				const inputActions = props?.inputActions ?? null;
				const [busy, setBusy] = React.useState(false);
				const [notice, setNotice] = React.useState(null);
				const busyRef = React.useRef(false);
				const noticeTimer = React.useRef(null);
				const elapsedTimer = React.useRef(null);
				const startRef = React.useRef(0);
				const elapsedRef = React.useRef(0);

				// stateRef：包装的 submit 在任意时刻读最新 imageIds/draft，
				// 不捕获渲染期旧值（README：stateRef 读最新）。
				const stateRef = React.useRef({ imageIds: [], draft: "" });
				const imageIds = input?.imageIds ?? [];
				const attachmentEpoch = stateRef.current.imageIds.length === imageIds.length && imageIds.every((id, i) => stateRef.current.imageIds[i] === id) ? stateRef.current.attachmentEpoch : {};
				stateRef.current = {
					attachmentEpoch,
					sessionId, directory, inputActions,
					imageIds: [...(input?.imageIds ?? [])],
					draft: typeof input?.draft === "string" ? input.draft : ""
				};

				// A snapshot is one capability epoch, never a permanent provider/model cache.
				const capabilityRef = React.useRef(null);
				const requestRef = React.useRef(null);
				const mountedRef = React.useRef(true);
				function currentCapability() {
					const { directory, sessionId } = stateRef.current;
					let snapshot = null;
					try { snapshot = directory?.store.getSnapshot(); } catch { /* Native on unavailable store. */ }
					const provider = snapshot?.current?.provider;
					const model = snapshot?.current?.model;
					const status = snapshot?.status;
					const old = capabilityRef.current;
					if (old && old.directory === directory && old.sessionId === sessionId && old.snapshot === snapshot && old.provider === provider && old.model === model && old.status === status) return old;
					const epoch = { directory, sessionId, snapshot, provider, model, status, supportsImages: null };
					capabilityRef.current = epoch;
					requestRef.current?.abort();
					if (sessionId && status === "ready" && typeof provider === "string" && provider.trim() && typeof model === "string" && model.trim()) {
						fetch("/api/dsh-vision-bridge/capabilities", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ provider, model })
						}).then(async (res) => {
							if (!res.ok) return;
							const data = await res.json();
							if (capabilityRef.current === epoch && currentCapability() === epoch && data.provider === provider && data.model === model && typeof data.supportsImages === "boolean") epoch.supportsImages = data.supportsImages;
						}).catch(() => {});
					}
					return epoch;
				}
				React.useEffect(() => {
					let stop;
					try { stop = directory?.store?.subscribe(() => currentCapability()); } catch { /* Native if service is unavailable. */ }
					currentCapability();
					return () => { stop?.(); capabilityRef.current = null; requestRef.current?.abort(); };
				}, [directory, sessionId]);

				React.useEffect(() => {
					requestRef.current?.abort();
				}, [attachmentEpoch, inputActions]);

				function flash(text, ms) {
					if (!mountedRef.current) return;
					setNotice(text);
					if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
					noticeTimer.current = setTimeout(() => {
						noticeTimer.current = null;
						setNotice(null);
					}, ms ?? 4000);
				}

				function setBusyUi(next) {
					if (!mountedRef.current) return;
					setBusy(next);
					if (elapsedTimer.current !== null) {
						clearInterval(elapsedTimer.current);
						elapsedTimer.current = null;
					}
					if (next) {
						elapsedRef.current = 0;
						startRef.current = Date.now();
						elapsedTimer.current = setInterval(() => {
							elapsedRef.current = Math.floor((Date.now() - startRef.current) / 1000);
							setNotice("正在识别图片（已等待 " + elapsedRef.current + " 秒）…");
						}, 1000);
					}
				}

				/**
				 * 提交时转换：图片 → describe → 描述入 draft + 移除 chips → 原提交。
				 * @returns {Promise<'describe'|'keep'|'failed'>} 结果；failed 时不提交。
				 */
				async function convertAndSubmit(epoch, original) {
					const start = stateRef.current;
					const ids = start.imageIds;
					const conversation = ctx.get("conversation");
					if (ids.length === 0 || !conversation) return "failed";
					const attachments = conversation.draftImages(ids);
					const files = attachments.map((a) => a.file).filter((f) => f != null);
					if (files.length !== ids.length) {
						// 2026-08-15：图片附件尚未就绪（典型：粘贴后立即发送，上传仍在途）。
						// 旧实现此处静默 return，用户侧表现是「点了发送毫无反应」——被当成插件坏了。
						flash("图片尚未上传完成，未发送；稍候片刻再点发送（图片已保留）", 6000);
						return "failed";
					}
					const big = files.find((f) => f.size > MAX_SINGLE_IMAGE_BYTES);
					if (big) {
						flash("单张图片超过 8MB，自动识别不支持；图片保留，可改走 subagent_vision 看路径", 6000);
						return "failed";
					}
					const valid = () => {
						if (!mountedRef.current || currentCapability() !== epoch || stateRef.current.inputActions !== start.inputActions || stateRef.current.attachmentEpoch !== start.attachmentEpoch) return false;
						const latest = conversation.draftImages(ids);
						return latest.length === files.length && latest.every((a, i) => a.file === files[i]);
					};
					const images = await Promise.all(files.map(async (f) => ({
						mime: f.type || "image/png",
						base64: await fileToBase64(f)
					})));
					if (!valid()) {
						flash("模型、会话或图片已变化，未发送；图片保留，请重试", 6000);
						return "failed";
					}
					const controller = new AbortController();
					requestRef.current = controller;
					const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
					try {
						const res = await fetch("/api/dsh-vision-bridge/describe", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ provider: epoch.provider, model: epoch.model, images }),
							signal: controller.signal
						});
						const data = await res.json().catch(() => null);
						if (!valid() || controller.signal.aborted) {
							controller.abort();
							flash("模型、会话或图片已变化，未发送；图片保留，请重试", 6000);
							return "failed";
						}
						if (res.ok && data != null && data.mode === "describe" && typeof data.text === "string" && data.text.trim() !== "") {
							// 用转换完成时的最新 draft（用户在等待期间输入的内容不被覆盖）
							const latest = stateRef.current;
							const prefix = latest.draft.trim() === "" ? "" : latest.draft + "\n\n";
							inputActions.setDraft(prefix + "📷 [图片自动识别] " + data.text.trim());
							for (const id of ids) inputActions.removeImage(id);
							original();
							return "describe";
						}
						if (res.ok && data != null && data.mode === "keep") { original(); return "keep"; }
						flash("图片识别失败，未发送；图片保留可重试", 6000);
						return "failed";
					} catch (error) {
						if (!valid()) flash("模型、会话或图片已变化，未发送；图片保留，请重试", 6000);
						else if (error?.name === "AbortError") flash("图片识别超时（100s），未发送；图片保留可重试", 6000);
						else flash("图片识别失败，未发送；图片保留可重试", 6000);
						console.warn("dsh-vision-bridge:", error);
						return "failed";
					} finally {
						clearTimeout(timer);
						if (requestRef.current === controller) requestRef.current = null;
					}
				}

				// 包装 inputActions.submit（一次性，__visionWrapped 防重复）。
				React.useEffect(() => {
					if (!inputActions || typeof inputActions.submit !== "function") return;
					const original = inputActions.submit;
					if (original.__visionWrapped) return;
					const wrapped = () => {
						const epoch = currentCapability();
						if (epoch.supportsImages !== false) return original();
						if (busyRef.current) {
							flash("正在识别图片，请稍候…", 3000);
							return;
						}
						const ids = stateRef.current.imageIds;
						if (ids.length === 0) {
							original();
							return;
						}
						busyRef.current = true;
						setBusyUi(true);
						setNotice(null);
						convertAndSubmit(epoch, original).then((result) => {
							if (result === "describe" || result === "keep") {
								// 成功提交前清掉 busy 期间残留的"正在识别图片（已等待 N 秒）…"提示
								if (mountedRef.current) setNotice(null);
							}
						}).catch((error) => {
							console.warn("dsh-vision-bridge:", error);
							flash("图片识别失败，未发送；图片保留可重试", 6000);
						}).finally(() => {
							busyRef.current = false;
							setBusyUi(false);
						});
					};
					wrapped.__visionWrapped = true;
					inputActions.submit = wrapped;
					return () => {
						if (inputActions.submit === wrapped) inputActions.submit = original;
					};
				}, [inputActions]);

				React.useEffect(() => {
					mountedRef.current = true;
					return () => {
						mountedRef.current = false;
						requestRef.current?.abort();
						if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
						if (elapsedTimer.current !== null) clearInterval(elapsedTimer.current);
					};
				}, []);

				if (!busy && notice === null) return null;
				const style = {
					boxSizing: "border-box",
					width: "100%",
					maxWidth: "calc(var(--dsh-composer-card-max-width, 760px) - 16px)",
					margin: "0 auto 4px",
					padding: "6px 12px",
					borderRadius: "10px",
					background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))",
					color: "var(--dsw-alias-label-secondary, #888)",
					fontSize: "12px",
					lineHeight: "18px",
					display: "flex",
					alignItems: "center",
					gap: "8px"
				};
				return React.createElement("div", { style }, React.createElement("span", null,
					busy ? (notice ?? "⏳ 正在识别图片…") : notice));
			};
		}

		function apply(ctx) {
			const dock = makeVisionDock(ctx);
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "vision-bridge",
				order: 100
			}, dock));
		}

		exports.inject = ["slots"];
		exports.apply = apply;
		exports.makeVisionDock = makeVisionDock;
		return module.exports;
	}
});
