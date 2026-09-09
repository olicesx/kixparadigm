# 多模态模型的视觉桥豁免

来源：用户先提出移除外部视觉通道，随后改为“或者不移除给真正有视觉能力的模型豁免该插件的管辖”。本任务保留 bridge、subagent_vision、原生 read_image 与提供方配置，只调整视觉桥的接管条件。

状态：已完成。源码、独立源码审查、中英文全套测试、安装同步、同服务重载与最终 realserved 浏览器验收均通过。边界见文末。

## 行为约定

| 当前精确 provider/model 的能力 | 提交行为 |
|---|---|
| 宿主明确声明 `image` 输入 | 原生提交；不读图转 base64、不检查桥的 8MB 限制、不修改草稿或图片、不调用转描述接口 |
| 宿主明确声明非空输入类型且不含 `image` | 保留文字模型的图片转描述流程，失败时保留原图 |
| 能力缺失、查询失败或模型选择尚未稳定 | 原生提交，由宿主校验；不隐式将图片送给外部视觉供应商 |

豁免基于宿主解析后的能力元数据，不根据模型名称推测。原生图片的大小、格式和模型能力检查仍由宿主执行。现有 Enter 原生提交路径保持原行为；文字模型的转描述仍针对点击发送路径。

## 为什么需要本地能力查询

真实 GUI 基线中，客户端 POST 只带 `images`，服务端现有 keep 分支却要求 `provider/model`，所以界面选择 GPT-6 Astra 后仍会转描述。独立浏览器基线已捕获 describe 请求和被转换为纯文字的原生提交负载；外部调用被测试夹具拦截，未实际识图。

当前宿主公开的 `session.models` 和 `llm.models` 只投影模型名称、标识和推理档位，没有 `inputModalities`。因此桥内增加只读能力查询，输入精确 provider/model，使用宿主 `llm.resolveModelInfo`，只返回身份和图片能力三态。该查询不接收图片、不读取视觉凭据、不调用识图推理；不修改 DSH 上游模型目录。

客户端随模型目录变化预取能力，点击时重读当前快照。旧查询、模型切换或配置刷新不能沿用过期结果。文字转换期间如果模型、会话或图片集合发生变化，应丢弃旧转换结果并保留当前草稿和图片。已经发出的外部请求无法追溯撤销，不能声称切换模型后该次请求从未发生。

## 当前会话模型的声明补全

用户指出当前模型也支持多模态后核实：`settings.yaml` 的 `llm-deepseek.models` 中，`deepseek-v4.1-flash-expires-on-0910` 原本没有 `inputModalities`，因此被当作未知能力走原生提交、由宿主按未声明拒绝图片；同提供方的 `deepseek-v4-flash-vision-exp` 则已声明 `[text, image]`。

经用户确认后，为当前模型补上与已有视觉模型一致的声明：

```yaml
inputModalities: [ text, image ]
imagePixelBudget: 640000
imageMaxBytes: 1048576
```

验证：YAML 解析通过，设置热更新后能力接口对 `deepseek-official/deepseek-v4.1-flash-expires-on-0910` 返回 `supportsImages: true`；同一会话的宿主原生 `read_image` 成功返回 8×8 测试图片内容。因此该模型现在走原生收图、桥自动豁免，不再转描述。这是用户级控制平面配置改动，仅改这一条模型声明，未改提供方、凭据或其他模型。

## 验证与部署记录

- 修改前浏览器基线：`/tmp/kix-vision-exemption-qa/baseline.json`。
- 基线客户端 SHA-256：`33f9b1074d718b1a55258336c17c7a475138dea0b72d0f9002d91b5aca6efbc9`；源、中英镜像、安装副本与当前服务响应一致。
- 真实 GUI：`http://127.0.0.1:33236`；原服务：`dsh-web.service`。不使用替代 GUI 验收。
- 实现位于 `dsh/vision-bridge/{index.js,client.js,test.js,package.json}`，与 `en/bridge/` 四个对应文件逐字节一致。增加原生 model-selection 客户端依赖；没有改 DSH 上游或提供方配置。
- 定向回归 20/20 通过，中英六个 JS 文件语法检查通过。独立源码审查未发现阻断问题；服务端对旧无身份请求的 keep、零凭据访问与零外呼有真实注册 handler 的隔离测试。
- 根目录与 `en/` 的 `npm test` 均 exit 0；两者 bridge 测试均 20/20，最终插件批次分别 37 pass / 1 skip / 0 fail 与 35 pass / 1 skip / 0 fail。skip 是 opt-in 浏览器 smoke。完整日志 `/tmp/kix-vision-exemption-test-zh.log`、`/tmp/kix-vision-exemption-test-en.log`。
- 浏览器 source-route 验证 11 场景通过：image 小图与 9MiB 图片均 describe 0 / FileReader 0，原生序列化保留完整图片；明确 text 正常转换；unknown/loading/selecting 原生；切换和旧能力晚返不沿用；转换中换模型或加附件不应用旧结果。证据 `/tmp/kix-vision-exemption-qa/source-route.json`，可重放脚本同目录 `source-route.spec.mjs`。该阶段用原 URL 和新客户端字节，但能力/描述端点为 fixture，最终模型提交被拦截，未执行真实外部识图或模型推理。
- 已执行仓库现有安装器；四个 bridge 文件的源、中英镜像、安装副本一致，中英 DSH-ADAPTATION 文档安装一致。客户端 SHA-256 `85a98fd34f17bf2e487b32c401934ec337191e7c7f8ec0b1425c1a20beaad178`；服务端 `1bd094867eb4dbbc7f150922d573ee43328a9527dbd83be16edb8d7f80eadcf3`。安装前备份 `/tmp/kix-vision-exemption-backup-dBrUb6/dsh-vision-bridge`。
- 原进程 PID 455789 仍持有旧服务端模块，故执行同服务重载。一次性重载脚本 `/tmp/kix-vision-exemption-reload.cjs` 以实际 pluginInventory RPC 和新 capabilities 接口均成功为就绪条件；启动 404/延迟注册/超时的三项脚本测试通过，避免重演仅凭 HTML 200 提前接续的问题。重载结果 `/tmp/kix-vision-exemption-reload-result.json` 状态 ready：bridge active，真实能力接口对 `su2api/gpt-6-astra` 返回 `supportsImages: true`。该脚本的自动续接队列因启动瞬间 `session.prompt` 尚未注册而失败，但不影响运行态就绪结论；该一次性 unit 已结束，未再重放。
- 最终 realserved 浏览器验收 9 场景通过（`/tmp/kix-vision-exemption-qa/realserved.json`，可重放 `realserved.spec.mjs`）。服务实际返回客户端两次均为 HTTP 200 且哈希与安装一致，加载清单含新增依赖；真实能力接口对 GPT-6 返回 true、对 `deepseek-official/deepseek-v4.1-flash` 返回 false。
  - 真实 GPT-6 hero：小图与 9MiB 图片点击后 describe 0、FileReader 0，原生负载图片逐字节完整；刷新后重复通过。
  - 真实历史会话（grok-4.6，能力 false）：正常转描述，请求携带 provider/model/images，描述进入草稿并移除图片。
  - fixture：明确 text 转换、unknown/selecting 原生保图、切换到 image 立即原生、转换中切到 image 不应用旧结果且保留原图。errors 为空。
- 独立部署复核从原 URL 取回客户端，确认与源仓和安装副本逐字节一致；安装服务端与已审源码一致，加载链接指向该目录；实际能力接口三态与多余字段 400 均符合设计。当前主会话模型为纯文字档，宿主原生 `read_image` 明确拒绝——这说明豁免没有绕过宿主能力校验，不是桥接回归；该调用本身不能替代浏览器图片提交证据。

## 边界

- 浏览器验收中的能力端点与描述端点为受控 fixture，最终模型提交被替换为记录并返回失败以阻止真实推理；未调用任何外部视觉供应商，未用真实模型推理图片。真实能力元数据、真实 served 客户端字节与真实宿主附件序列化是实际链路。
- 9MiB 为合成 PNG 加填充，验证浏览器附件与序列化；宿主后端的大小校验和真实大图推理未实测。
- 未刷新页面仍运行旧客户端：服务端会对其缺少身份的请求返回 keep，不再隐式外发，但旧 JS 的 8MB 限制仍在，完整豁免需要刷新页面。
- 文字模型在能力尚未确认时点击发送会走原生提交，可能被宿主拒绝图片；这是约定的保守策略，不宣称此时一定转换。
- Enter 仍走宿主原生键盘提交，不经过本插件；文字模型的 Enter 图片处理沿用原行为。
- 已发出的外部请求可被客户端中止等待，但不能追溯撤销；不声称切换模型后该请求从未发生。
- 未发布、未提交、未对外评论；改动保留在工作树。

