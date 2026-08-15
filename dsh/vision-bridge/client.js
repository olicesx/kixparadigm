// dsh-vision-bridge — client 半（v2 提交时转换模式）：composer dock 插件。
//
// v2 语义（2026-08 用户确认实现）：
//   - 粘贴/拖入图片 → 图片正常停留在输入框，不打断输入（与 v1 粘贴即转不同）；
//   - 点发送（inputActions.submit）→ 调服务端 /api/dsh-vision-bridge/describe
//     （无视觉模型 → GLM-4.6V 描述；有视觉模型 → mode "keep"）：
//       describe：描述写入 draft（`📷 [图片自动识别]` 前缀）+ 图片 chips 移除 → 再真正提交；
//       keep    ：原样提交（图片保留，模型自己看图）；
//   - 转换失败 / 超时（client 100s）→ 提示且不提交，图片保留可重试；
//   - 单图 >8MB → 快速失败提示（不发起请求，不提交）。
//
// 实现要点：
//   - 包装 props.inputActions.submit（InputActions 公开面，stable identity），
//     `__visionWrapped` 防重复包装；stateRef 读最新 imageIds/draft（包装闭包不持旧值）；
//   - 不依赖 session.id（hero 模式可用）；图片 File 仍经 conversation.draftImages(ids) 取；
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
				const session = props?.session ?? null;
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
				stateRef.current = {
					imageIds: input?.imageIds ?? [],
					draft: typeof input?.draft === "string" ? input.draft : ""
				};

				function flash(text, ms) {
					setNotice(text);
					if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
					noticeTimer.current = setTimeout(() => {
						noticeTimer.current = null;
						setNotice(null);
					}, ms ?? 4000);
				}

				function setBusyUi(next) {
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
				async function convertAndSubmit() {
					const ids = stateRef.current.imageIds;
					const conversation = ctx.get("conversation");
					if (ids.length === 0 || !conversation) return "failed";
					const attachments = conversation.draftImages(ids);
					const files = attachments.map((a) => a.file).filter((f) => f != null);
					if (files.length === 0) return "failed";
					const big = files.find((f) => f.size > MAX_SINGLE_IMAGE_BYTES);
					if (big) {
						flash("单张图片超过 8MB，自动识别不支持；图片保留，可改走 subagent_vision 看路径", 6000);
						return "failed";
					}
					const images = await Promise.all(files.map(async (f) => ({
						mime: f.type || "image/png",
						base64: await fileToBase64(f)
					})));
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
					try {
						const res = await fetch("/api/dsh-vision-bridge/describe", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ images }),
							signal: controller.signal
						});
						const data = await res.json().catch(() => null);
						if (data != null && data.mode === "describe" && typeof data.text === "string" && data.text.trim() !== "") {
							// 用转换完成时的最新 draft（用户在等待期间输入的内容不被覆盖）
							const latest = stateRef.current;
							const prefix = latest.draft.trim() === "" ? "" : latest.draft + "\n\n";
							inputActions.setDraft(prefix + "📷 [图片自动识别] " + data.text.trim());
							for (const id of latest.imageIds) inputActions.removeImage(id);
							return "describe";
						}
						if (data != null && data.mode === "keep") return "keep";
						flash("图片识别失败，未发送；图片保留可重试", 6000);
						return "failed";
					} catch (error) {
						if (error?.name === "AbortError") flash("图片识别超时（100s），未发送；图片保留可重试", 6000);
						else flash("图片识别失败，未发送；图片保留可重试", 6000);
						console.warn("dsh-vision-bridge:", error);
						return "failed";
					} finally {
						clearTimeout(timer);
					}
				}

				// 包装 inputActions.submit（一次性，__visionWrapped 防重复）。
				React.useEffect(() => {
					if (!inputActions || typeof inputActions.submit !== "function") return;
					const original = inputActions.submit;
					if (original.__visionWrapped) return;
					const wrapped = () => {
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
						convertAndSubmit().then((result) => {
							if (result === "describe" || result === "keep") {
								// 成功提交前清掉 busy 期间残留的"正在识别图片（已等待 N 秒）…"提示
								setNotice(null);
								original();
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

				React.useEffect(() => () => {
					if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
					if (elapsedTimer.current !== null) clearInterval(elapsedTimer.current);
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
