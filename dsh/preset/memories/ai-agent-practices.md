# AI Agent 编码实践经验（通用，跨项目适用）

> **DSH 适配注记（2026-08-16 插件化改造）**：本文件是方法论记忆（历史经验记录），其中
> Copilot 工具名（`replace_string_in_file`→`edit`、`read_file`→`read`、`grep_search`→`grep`、
> `run_in_terminal`→`pwsh`、`runSubagent`→`subagent`/`subagent_cross`、`vscode_askQuestions`→
> `ask_user_question`）在 DeepSeek Harness 中按 preset 根 `DSH-ADAPTATION.md` §1 映射理解；
> **经验语义原样适用**（编辑方式、GBK 伪象、WSL 双真相、token 纪律等教训不随工具名变化）。
> 本文件按需读取，不常驻。

## 编辑方式

- **源码文件编辑首选 `replace_string_in_file`**，不受 shell 转义影响
- **禁止终端 inline 脚本编辑源码**（PowerShell/python -c），转义极易出错导致文件损坏，本次已两次 git checkout 恢复
- **例外：简单 `-replace` 字符串替换可以 inline**（PowerShell 单行 `(Get-Content) -replace ... | Set-Content`），因为没有复杂转义，风险低。但涉及正则元字符、多行块、heredoc 时仍必须用 `replace_string_in_file` 工具
- 需要多行脚本操作时，先写脚本文件再执行，不要 inline
- **PSScriptAnalyzer unapproved verb 报错**：自定义函数名必须用 approved verb（`Write-/Get-/New-/Set-/Remove-` 等），否则 lint 报错。`Log-Info`/`Ensure-Dir` 会报，改为 `Show-Info`/`New-DirIfMissing`。即便如此仍可能因历史命名缓存误报，确认文件实际内容即可


## GitHub PR review 发布机制（2026-08-08 PR#44 实证）

- **REST 没有「向 pending review 加行内评论」端点**：`POST /repos/{o}/{r}/pulls/{n}/reviews/{id}/comments` 返回 404（该路径只支持 GET 列出评论）。正确姿势：在 `POST /pulls/{n}/reviews` 创建时用 `comments[]`（`{path, line, side:"RIGHT", body}`）一次性带上，再 `POST .../reviews/{id}/events {"event":"REQUEST_CHANGES"}` 提交。创建后想再加评论需 GraphQL `addPullRequestReviewThread`，不如重建
- **多语言 payload 构建用 Python 最可靠**：PowerShell `ConvertTo-Json` 会把 `Get-Content` 读出的字符串序列化成 `{"value": ...}` 且可能异常膨胀（本次 6 条评论 payload 变 99MB → GitHub 400）。用 `python json.dump(payload, ensure_ascii=False)` 写 UTF-8 文件 + `gh api --input` 发送
- **PowerShell 显示层 GBK 解码伪象**：`gh api --jq '.body'` 的中文在 PowerShell 里显示乱码 ≠ GitHub 存储错误。用 `cmd /c "gh api ... --jq .body > file"` 拿原始字节，再用 read_file 验证真实存储
- **评审流程细节**：`ConvertFrom-Json` 解析 gh 响应报错（响应含中文被 GBK 误读）时，POST 往往已成功——先用 GET 校验再决定是否重试；`gh` 的 DELETE pending review 可用（本次删空 review 重建成功）

## 最小改动原则 (YAGNI)

- 只改与需求直接相关的代码
- **不加条件分支除非用户明确要求**：能无条件处理的逻辑不加 if/else
- 不新增"可能有用"的字段、方法、抽象层

## 因果倒置检测（跨项目通用）

- **输入常量 vs 派生值**：设计参数时要分清哪个是"输入"（人为指定），哪个是"派生值"（应由其他输入推导）
- **典型反模式**：把派生值当成输入常量硬编码，导致：① 实际运行超预算 → 事后改写数值"合理化"；② 无法随任务规模伸缩
- **案例**：某调度系统的"并发预算"硬编码为固定值 5，实际任务量超限时被临时解锁（事后改监控报告"合理化"为零超限）。根因：并发预算应是任务数的派生函数（如 `ceil(task_count/3) + 耦合数 + 1`），不是固定常量
- **识别方法**：如果一个"约束值"经常被超限或需要事后调整，大概率它是派生值被误当成了输入常量。真正的硬约束（如上下文窗口大小）很少被超限，因为它是物理限制

## 引用论文的过拟合陷阱（跨项目通用）

- **挪用论文标量结论 ≠ 实现论文核心机制**：引用真实论文但只搬数字/名字，丢掉过程性核心，是比"虚构引用"更隐蔽的过拟合
- **案例**：引用某 DAG 路由论文主张"按拓扑动态路由"，却把论文 benchmark 均值当全局并发常数；引用某错误累积论文，却只做单次越界门禁（丢了跨阶段累积度量）
- **隐藏常数识别**：派生公式里若出现无法追溯到第一性原理的固定比例（如 `/3`），仍是硬编码，只是穿了派生的外衣
- **对策**：抓论文的"算法/度量"而非"数字"。参数应是"从当前输入实时计算的函数"，不是"论文报告的经验均值"

## 论文引用双坑：出处混引 + 属性通胀（2026-08-01 kixparadigm 实证）

- **出处混引**：Brooks "The hardest single part of building a software system is deciding precisely what to build" 常被标 The Mythical Man-Month (1975)，实际出自 No Silver Bullet (1986) 后记/正文，学界本身混引。SKILL 内一处标 1975、一处标 1986 自相矛盾才暴露。对策：同文件多处引用同一作者须统一出处
- **属性通胀**：把第②来源的主张挂到第①来源名下（"用户说不清是常态"是需求工程 IKIWISI 的主张，却挂在 Brooks 名下——Brooks 只谈任务难度不谈用户会错）。对策：写论文支撑块时逐句问"这句是谁说的"
- **领域术语自创**："无法靠迎合发现"是 AI 反谄媚关切（sycophancy），需求工程用"被动收集 vs 主动 elicitation"，不叫"迎合"。引用成熟领域时用领域自己的对立概念
- **框架迁移未标注**：Radical Candor 是经理→下属管理框架，迁移到 AI-用户关系是类比，须标注"类比迁移"而非直接"✅ 权威框架"
- **审查发现此坑的信号**：同文件对同一作者出现两个年份 / 引文下跟的推论比原文强 / 出现领域没有的术语


## bwrap 平台语义（2026-08-06 私有项目 C PR#23 审查实证，已对照官方 man page）

- `--perms OCTAL` **只影响下一个操作**（下一个 `--dir`/`--tmpfs`），之后恢复默认 0755。`--dir` 已存在目录时忽略 `--perms`
- bwrap 沙箱根是**全新空 tmpfs**（非宿主根挂载继承），未显式 bind 的路径在沙箱内不存在——`--dir` 只在沙箱内创建目录，无宿主副作用
- `--unshare-user` 命名空间只映射调用者单一 uid → 沙箱内目录 0755 vs 0700 实际无可读性差异（单 uid 命名空间）
- 审查沙箱 args 序列时：`--perms` 与目标 `--dir` 之间若插入条件性 parent args（如 home 不在 /home 下时），0700 会被 parent 消耗，home 落到 0755
- **`--perms OCTAL` 只作用于下一个受影响操作（--dir/--file/--tmpfs）；`--dir` 对已存在路径（含 --tmpfs 刚创建的挂载点）是 no-op，不 chmod**（2026-08-06 bwrap 0.9.0 WSL 实测：`--tmpfs /srv/x --perms 0700 --dir /srv/x` → 755；`--perms 0700 --tmpfs /srv/x` → 700）。要给 tmpfs home 设 0700 必须 `--perms 0700 --tmpfs home`，不能 `--tmpfs home` 后再 `--perms 0700 --dir home`
- **审查测试断言陷阱**：断言 args 序列包含 `--tmpfs X --perms 0700 --dir X` 不代表权限生效——该序列实际产出 0755。测试应断言真实语义（实测 stat）而非参数顺序
- **--perms 语义权威来源**：bwrap man 页明文 "`--perms 0700 --tmpfs /a --tmpfs /b` will mount /a with permissions 0700, then return to default for /b"，可作权威引用

## 平台/库行为类断言必须落地权威证据（跨项目通用，2026-07-30 实证）

- **审查/分析中凡断言"某平台/库会怎样解析/运行"的 finding，必须先落地权威证据，否则是误报发生器**。两类证据缺一不可：① 仓库内实际 schema/源码（migration、配置、定义）；② 官方文档原文。只凭"我觉得/常识"下的判断不算数
- **典型案例**：审查 示例项目 PR #26 时把 ClickHouse `created_at` naive 写入标为 🟡 major「按服务器时区解析会偏移」。**实为误报**：`migrations.rs` 列定义是 `DateTime64(3, 'UTC')`，显式 UTC 列会按**列时区**而非服务器时区解析 naive 字符串（ClickHouse 官方 DateTime64 文档确认）。审查既没读 migrations 文件、也没引官方文档，把"字符串无 tz 后缀"错当成"按 server tz 解析"
- **混淆点**：列**显式带时区** vs 列**无时区(用 server tz)** 是两种语义。`DateTime64(3,'UTC')` 收 naive 串按 UTC；`DateTime64(3)` 才按 server tz。不能因为写入值无后缀就推断解析时区
- **对策（审查流程硬规则）**：任何依赖平台语义的 finding，发布前自问"我读过仓库里的实际定义吗？我引用了官方文档哪一段？" 没有 → 降级为问题(question)而非结论(finding)，或先读文件/查文档再定级。宁可问一句"请确认该列是否显式 UTC"，也不要直接标 major 制造误报

## Self-serving benchmark/report 的归因降级（2026-08-05 私有项目 H vs dae 实证）

- **数据可信 ≠ 归因可信**：第三方/竞品 benchmark 报告里，**测量数据**（带第三方参照 + 自承弱点的）可采信，但其**对自己有利的归因分析**（"对手缺 X / 我们专门绕开 Y"）必须独立读源码验证，天然降置信度
- **案例**：私有项目 H benchmark report 测出 dae UDP P8 崩溃（数据有 sing-box 参照，可信），但归因为"dae 缺 per-flow queuing / 共享 socket 竞争"——**实为误判**：dae `udp_ordered_dispatcher.go` 早就有 per-flow queue + bounded worker scheduler + batch ReadBatch，git 证明 私有项目 H 测的版本（ae056a6a）已包含。真实根因 私有项目 H 自己也只给三个 "or" 猜测
- **对策**：读竞品 report 时强制分两层——① 数据（看方法学严谨度 + 第三方参照）② 归因（一律当 claim，读对方代码验证后再接受）。self-serving 归因尤其要查：报告方说"对手缺 X"时，先 grep 对手代码确认 X 是否真不存在
- **与既有条目关系**：这是"平台/库行为断言须落地证据"的延伸——平台断言的对象不只是 ClickHouse/Go 语义，也包括**第三方对自家代码行为的断言**

## 加密后端瓶颈假设须实测（2026-08-05 dae UDP 诊断实证）

- **假设"Go crypto 慢，换 BoringSSL cgo 大幅提升代理吞吐"是错的**：AES-NI 下 Go `crypto/aes` GCM 单核实测 **50 Gbps**（6289 MB/s @ 1200B），与 BoringSSL 等价。代理实际单流 0.9 Gbps，AEAD 有 **70× 余量**，绝对不是瓶颈
- **对称陷阱**：看到 Rust+BoringSSL 引擎（私有项目 H）比 Go 引擎（dae）快 6×，直觉归因"加密后端差异"——实测证伪。私有项目 H 的优势在 **Rust runtime 整体**（无 GC + 零开销抽象 + quinn 的 per-packet 效率），不在 AEAD
- **Go 网络代理的 per-packet 瓶颈在 runtime 开销**（goroutine 调度 / channel 同步 / GC / QUIC 库 per-packet 固定成本如 datagramQueue 锁 + 解帧），**不在加密**。AES-NI 普及后 AEAD 极少是网络代理瓶颈
- **对策**：建议"换加密库/CGo 提升吞吐"前，先 bench 现有 crypto 单核吞吐（几行 `crypto/aes` + `cipher.NewGCM` + `b.ReportMetric`）确认是否真瓶颈；这是个 5 分钟的实验，能省掉大改 BoringSSL 的无效投入
- **关联**：这是"平台/库行为断言须落地证据"在加密领域的实例——不要凭"Go 慢于 Rust"的笼统印象推断具体子组件（AEAD）是瓶颈

## 证据门禁的验证维度陷阱（跨项目通用，PR#26 + PR#2984 实证）

PR#26 教训是"没取证"。PR#2984 是**升级版失败**：取了证，但**挑错验证维度**——验证了表面/局部属性（调用链存在/Unwrap 终止性），漏了深层/全局语义（被调用方 `check()` 的 early return / `Unwrap` 的写副作用 `f.selected=""` / Go 嵌入静态绑定跳过 override）。比"没取证"更隐蔽——有"取证"动作更易自我麻痹。

- **核心反模式**：看调用链不读被调用方函数体；验读安全漏写副作用；凭"能复用"忽略语言分派差异（Go 嵌入=静态 / Rust dyn=动态）；声称"已验证"无工具证据
- **对策**：识别盲点**方向**（深度/读写/语言/自信/广度），给补足**工具**（read_file 读实现 / 反方辩护三问 / review-of-review 独立 agent），**但不规定每类 finding 必须覆盖哪个维度**（固定打勾表会过拟合，让模型从"理解"退化为"打勾"）。模型推理是主力，图谱只补足已知盲区
- **反方辩护测试（发布 review 前，对每条 major+ 和"建议"类 finding 必跑）**：① 作者最可能的技术反驳点？② 我验证的最深层属性是什么，还是停在表面调用链？③ 对建议类：目标语言的分派/类型/并发/所有权模型下成立吗？任一答不出 → 降级为 question 或补验证

## 阶段二相性 + 规则是负债（跨项目元原则，2026-07-31，v5.6）

三个发现的有机结合，作为 AI 编排的最高指导（论文：ToT Yao'23 / Self-Refine Madaan'23 / Sutton Bitter Lesson 2019）：

1. **发散/收敛二相性**：解决问题（创造）需要发散，验证需要收敛。两者是不兼容的认知模式，混合则互相污染（ToT 实证：生成与评估分离 > 混合）。→ 创造阶段最小规则给推理空间，验证阶段结构化补足盲点
2. **规则是负债**（Sutton："building in human knowledge has consistently been shown to be counterproductive"）：每条规则有维护成本+压制涌现风险。新增前问"模型能力提升后还有价值吗"，没价值不加，老规则定期修剪
3. **补足非限制**（v5.5 已落地）：机械性只用在"动作"（读文件/调子 agent），不用在"思考"（固定打勾表）

**关键判断**：编排工程的完备优化 = 加一个好的元原则（二相性）+ 修剪存量，而非加更多具体规则。元原则是**生成性的**——有了它，未来加任何规则都会自动问"这属于创造还是验证阶段？密度合适吗？补足还是限制？"。这比 100 条具体规则更有效（Sutton 的核心教训）

**论文可靠性分级**：✅ Sutton/ToT/Self-Refine/Constitutional AI/CoT（已独立验证经典，可作硬依据）> ⚠️ AdaptOrch/EvoClaw 等近年编排论文（曾引用但未独立验证，算法有效但论文依据存疑，不作硬依据）

**操作推论（2026-07-31 实证，PR#2980 连续三次翻车）**：skill 中的内容分两类，对待方式截然不同——
- **模板/格式/流程类（机械）→ 完全遵守，不变通、不发挥、不"优化"**：双段结构、严重级别 emoji、summary 文本、发布 gate 步骤、frontmatter schema、命名约定、输出骨架。这些是"皮肤"，照搬即可，自作聪明变通只会翻车（如把真人简述写成导航、把 emoji 换成 [Category]、把英文换成中文）。**判定信号**：规则描述的是"长什么样/按什么顺序"而非"怎么判断"。
- **思维/判断类（创造）→ 参考，给推理空间**：证据门禁取什么证、盲点图谱查哪个维度、反方辩护怎么问、severity 怎么定。这些是"大脑"，靠推理发挥，skill 给方向不给 checklist。**判定信号**：规则描述的是"怎么判断/查什么"。
- **二分法与二相性同源**：模板 = 收敛/执行侧（机械），思维 = 发散/创造侧（自由）。混淆就会把模板当建议（漏执行）或把思维引导当模板（变打勾表）。kixParadigm SKILL.md 自己写的"大脑换了，皮肤不变"就是这个意思——但我前三次执行都违反了，把皮肤当成了可选建议。
- **执行前自问**：当前 skill 的这条规则是"皮肤"还是"大脑"？皮肤 → 找到源定义（如 `VSCODE_USER_PROMPTS_FOLDER/kixpower-review.prompt.md`）照抄；大脑 → 理解意图后自由发挥。

## WSL 仓库 git 操作纪律（2026-07-31 实证）

- **禁止用 Windows git 在 WSL UNC 路径（\\wsl.localhost\...）上执行写操作**：`git worktree add` 在 UNC 路径上会把主工作区 checkout 成 CRLF（169 个文件全行替换，diff 显示 64705+/64705-），且 worktree 的 gitdir 指向 UNC 路径导致 WSL git 无法使用该 worktree
- **恢复方法**：`git checkout -- .`（工作区被污染前若 status 干净则安全）
- **正确姿势**：WSL 仓库的一切 git 写操作（worktree add/remove、checkout、reset）都在 `wsl -d Ubuntu -e bash -c "..."` 或脚本文件里执行；PowerShell 里只做只读操作（diff/log/show）
- 测试 PR 用 worktree 时：先在 WSL 里 `git worktree add /tmp/xxx pr-branch`，测试完 WSL 里 remove

## VS Code UNC 编辑与 WSL 磁盘脱节（2026-07-31 实证）

- **症状**：git stash/pop 等 WSL 侧写操作后，VS Code 里 `replace_string_in_file`/`create_file` 的编辑只改编辑器 buffer，**不落盘**（WSL 磁盘文件不变，mtime 不变，git diff 不变）。`read_file` 读到的是 buffer（新内容），`run_in_terminal` grep 读到的是磁盘（旧内容）——两个"真相"
- **影响**：调试打印加了等于没加（编译用的是磁盘）；stub 修改了等于没改；最终 buffer 可能残留旧内容，用户保存会覆盖磁盘修复
- **对策**：任何编辑后**必须 WSL 侧 grep/md5 验证落盘**；git stash 前后格外小心；恢复一致用 `workbench.action.files.save`（有时有效）或 reload window，或干脆用 WSL python 脚本文件改磁盘（create_file 写脚本到 WSL 路径 → python3 执行 → 删除）
- **同场教训**：`go test` 非 `-v` 模式吞成功测试的 stdout（fmt.Printf 不显示）→ 误判"stub 未被调用"。调试打印必须配 `-v`

## 测试 stub 必须镜像真实传输语义（红-绿验证陷阱，2026-07-31 实证）

- **症状**：修复 deadline 继承 bug 后新增黑盒测试，RED 实验（revert 修复）竟然 PASS——因为 stub forwarder 直接返回答案、**不检查 ctx**，掩盖了"过期 ctx 立即失败"的真实行为（真实 DoTCP 会 DialContext/SetDeadline 失败）
- **对策**：涉及 ctx/deadline/取消语义的测试，stub 必须镜像真实行为（如 `if err := ctx.Err(); err != nil { return nil, err }`），否则测试无区分度，红-绿验证假红
- **红-绿纪律**：RED 实验必须真实 FAIL（exit 1）+ 时长符合预期（如 5s vs 8s），"ok 但时长不同"不算有效红

## PowerShell Hook 测试方法（pwsh 管道 vs cmd 重定向）

- **pwsh 管道 `Get-Content | & pwsh -File hook`** 传递的是**对象**（string 数组），子进程 `$Input` 枚举的是行对象，不是字节流 → JSON 首字符可能被污染，ConvertFrom-Json 失败
- **cmd 重定向 `cmd /c "pwsh -File hook < file.json"`** 传递的是**字节流**，子进程 `$Input | Out-String` 能正确读取完整 JSON → 这是 VS Code hook 的实际调用方式
- **测试 hook 时必须用 cmd 重定向**（或 `[Console]::In.ReadToEnd()`），不能用 pwsh 管道
- **案例**：某 pre-commit hook 在 pwsh 管道测试下静默退出（JSON 解析失败 position 0），改 cmd 重定向测试下正确触发。实际运行（VS Code 字节流 stdin）证明 hook 一直工作，只是测试框架错了

## YAML frontmatter 正则陷阱（多字段不紧邻 + inline 数组）

- 正则 `(\w+):\s*\n\s+(next_field):` 要求两个字段**紧邻**，但实际 frontmatter 中两个字段之间常有其他字段
- **正解**：用 `(\w+):[\s\S]*?(next_field):`（`[\s\S]*?` 非贪婪匹配任意字符含换行）
- **inline YAML 数组**也要支持：`key: [a, b, c]` 不能用 `key:\s*\n((?:\s*-\s*.+\n?)+)`（多行列表正则）匹配
- **inline 数组正则**：`key:\s*\[([^\]]+)\]` 然后 `,` 分割
- **案例（同项目连续踩 3 次同类坑）**：① 读某字段时正则要求紧邻，但中间隔了 4 个字段 → fallback 静默失效回退默认值；② 另一处 4 个并列字段同样紧邻正则全失效（回归才发现）；③ plan 文件全用 inline 数组 `[a, b, c]`，旧正则只支持多行 `- item` 列表 → 全部被误判 ungated（HIGH_RISK 61%），实际 PASS 0%。**教训**：正则解析结构化配置时必须同时支持多行列表 + inline 数组，且字段间隔用 `[\s\S]*?`


## next/font 与 i18n 键教训（2026-08-11 taste-skill 重构实证）

- **next/font `variable` 类在 pages router + Turbopack 下不注入 CSS 变量**：`@font-face` 生成了但 `--font-geist-sans` 变量为空 → 字体不加载（回退系统字体）。解法：`_document.tsx` 手动注入 `:root{--font-geist-sans:${GeistSans.style.fontFamily}}` + `_app.tsx` 用 `GeistSans.className`。geist 包 `style.fontFamily` 返回 `'GeistSans'` 但 Turbopack @font-face family 是 `__nextjs-Geist`（不一致），`className` 方案正确匹配
- **CSS 变量不能向上继承**：body 的 `font-family: var(--font-x)` 读不到 body **子元素**（_app wrapper）上定义的变量 → 变量必须定义在 html/:root 或祖先
- **翻译键改名必须同步源串**：`api.ts` 的 `passwordPolicy.message` 是 i18n 翻译键（含 en-dash "8–128"）。只改 `i18n.ts` 键名不改 `api.ts` 源串 → 中文翻译回归（fallback 显示英文）+ en-dash 仍可见（taste-skill §9.G 违规）+ 新键成孤儿。**taste-skill 类 "消除 en-dash" 任务：源串可能在业务代码文件（api.ts）而非 i18n 文件**
- **Next 16 dev 副作用**：自动生成 AGENTS.md/CLAUDE.md（可删，或 next.config `agentRules:false`）+ 自动改 tsconfig（jsx: preserve→react-jsx，官方行为可保留）
- **async 终端每次开新 shell（cwd 重置）**：用 `npm --prefix <abs path> run dev` 不依赖 cwd；`Select-Object -First N` 截断管道会杀掉常驻进程（dev server）→ 重定向到日志文件
- 框架无关 JS（如 versionCheck.ts）读主题色：`getComputedStyle(document.documentElement).getPropertyValue("--primary")` 拼 `hsl()`，响应暗色模式

## 字段值 ≠ 模板
- 后端改字段值内容 ≠ 前端模板变更（已渲染字段无需动模板）；仅新增/删除字段、改名、改结构才改模板

## 跨层改动前确认范围

- 不确定是否需要跨层改动时，先用一句话向用户确认，再动手
- 例："目前只需改后端返回字段，前端模板已渲染该字段无需修改，对吧？"
- **对称角色链检查（2026-07-31 实证）**：给某角色（如 Dev/写侧）加能力时，必须检查同语义链上的对称角色（Review/审侧、QA/测侧）是否需同步覆盖，否则只改一半。案例：kixpower v5.3 给 Dev 加「读既有代码提取风格基线」后漏改审查模式维度 4（仍用通用标准不读仓库代码），用户追问"审查能吃到收益吗"才发现。写-审-测是三条独立执行路径，改一条不自动传到另两条

## 子代理委托策略

- **3+ 文件跨目录探索** → 派发 Explore 子代理（quick/medium/thorough），避免自己多次搜索撑爆上下文
- **编码实现** → 派发 ai-team-dev，prompt 中注入仓库经验（编辑方式、YAGNI 等）
- **简单搜索/单文件读取** → 自己做，不要过度委托

## Token 预算管理（防上下文溢出）

> ⚠️ 实证教训（2026-07-29 kixpower 改造）：勿凭主观感觉估水位。本会话曾凭"读了大文件+子代理报告"的感觉声称"83% 危险区"提前收尾，实际 VS Code 上下文条仅 12%（126.5K/1M，工具结果只占 3.9%）。水位线规则是经验参考，真实测量看 VS Code 上下文条；无测量时宁可继续推进也别凭感觉停手——后者正是 kixpower 过拟合的同款（经验法则当硬约束、估算代替测量）。

### 水位线规则

| 水位 | 已用比例 | 动作 |
|---|---|---|
| 安全 | < 60% | 正常操作 |
| 警觉 | 60-75% | 开始精简后续工具输出，优先 tail/head |
| 危险 | 75-85% | 停止子 agent 调用，手动完成当前步骤。提前准备手工会话交接 |
| 临界 | > 85% | **立即停止**。做一次手工会话交接（handoff），然后告知用户开新对话 |

### 触发时机

- **每轮子 agent 返回后**：评估上下文水位。若 ≥ 75%，不继续调下一个子 agent，改为生成 handoff 文档让用户开新对话
- **每次 `run_in_terminal` / `get_terminal_output` 前**：预期输出 > 200 行应追加 `| Select-Object -Last 100` 或 `| Out-String -Width 200` 裁剪
- **每次 `read_file` 大文件**：优先读行范围（startLine/endLine），不读整个文件

### 压缩/交接纪律

- **禁止在交接后引用完整 transcript**：handoff 文档不包含 "如需详细信息请读完整 transcript" 指引，那会导致新对话直接读大文件撑爆上下文
- **交接文档必须自包含但极简**：只含决策、文件路径、阻塞项、待办。代码细节用文件名+行号引用即可
- **优先使用 `docs/` 中已有文档**：PROJECT_BRIEF.md、plan.md、progress.md 已记录的信息不要在 handoff 中复述，用路径引用

### 子 agent prompt 大小控制

- 调用 `runSubagent` 时，prompt 不超过 5K tokens
- 需要传递大量上下文 → 先写入 `docs/sprint-*/progress.md`，再让子 agent 自己读
- **禁止在 prompt 中内嵌完整文件内容**，用文件路径替代

## 跨厂商模型策略（实证中，2026-08-06 首次实证）

- **历史偏差**：默认 `runSubagent` 调用没带 `model` 参数 → 全部同厂商 GLM-5.2，跨厂商杠杆从未启用（用户 2026-08-05 发现）
- **✅ 首次实证（2026-08-06 PR#23 sandbox 审查）**：主模型初稿结论 **APPROVE（0 major）**，跨厂商 DeepSeek-V4-Flash 独立 review 发现 2 个主模型漏掉的 **major 隔离逃逸**（① workspace bind 覆盖宿主 HOME 挂载点 → action 获宿主 home 读写；② --no-sandbox 下 TMPDIR 未校验直连宿主 /tmp）。复核后主模型全部采纳，结论改为 **CHANGES REQUESTED**。**跨厂商增量发现 > 同厂商 prompt 视角**——同厂商 GLM 子 agent 只确认了 retry 语义正确、未发现逃逸
- **✅ 第二次实证（2026-08-06 第二轮，作者修复后）**：主模型实测发现 custom home 0700 未生效（详见上「bwrap 平台语义」）；跨厂商独立复核**独立得出同一结论** + 补 bind-mount 别名纵深 finding + 确认无新 regression。两方一致 → 高置信发布 APPROVE
- **实证教训**：主模型对"自己刚读过的代码"有辩护倾向（读到 --dir home 和 workspace bind 但没连起来想 bwrap 后挂载覆盖语义）；跨厂商独立视角打破了这个盲点。bwrap 挂载顺序/覆盖语义类平台断言是跨厂商高价值区；此类"参数顺序 + 运行时语义"断言直接 WSL 实测最可靠，比纯读代码强
- **实证触发/方式**：平台/库语义断言、挂载/分派差异大、review 前最高置信、主模型刚深读代码的隔离/安全类 claim → 同 prompt 分别 GLM-5.2 + DeepSeek-V4-Flash 跑，对比 ① 一致性 ② 分歧 ③ 跨厂商增量
- **临时默认**：继续实证——每次合适 claim 跑跨厂商，累积 2-3 次实证后再定"全量 vs 按 claim 类型"策略
- **确切 model 字符串（2026-08-05 实测）**：`GLM-5.2 (CodingPlan) (gcmp.zhipu)` / `DeepSeek-V4-Flash (gcmp.deepseek)`——按主 agent 厂商取反；技能中 model 字符串必须实测后写死，报错时以错误返回的 `Available models` 列表为准
- **论文支撑**（机制详见 SKILL.md「跨厂商模型」）：cross-family 验证收益 > intra-family > self（Correlated Errors ICML 2026 2506.07962 + NYU 2512.02304）；verifier gain = precision − solver accuracy
- **DSH 自动路由（v5.9，kix-route 插件，2026-08-15）**：「模型自动选择可用模型」在 DSH 的落点是三层：主模型按需**选工具**（`subagent_cross` = 跨厂商观察者）+ 工具行只钉 `kix-route:<tier>` **哨兵模型名** + `plugins/kix-route.js` 在子代理首次请求的 agent/request waterfall 里按 llm 实时目录（listProviders/listModels/resolveModelInfo）解析成可用路由——cross = 父厂商取反（父 GLM→deepseek 系 / 父 DeepSeek→zai 系）、vision = 首个 inputModalities 声明 image 的模型、thinker = deepseek 系首选。**边界语义（v5.9.1）**：cross 在单厂商部署、vision 在全目录无 image 模型时**启动即报错**（throw，错误信息附注册清单 + 改用建议，随 run 失败带回父模型——假独立性比失败更糟，且 host 日志告警父模型看不见）；thinker 无 deepseek 时降级 agentDefaultModel（大预算深思考角色仍成立）+ 一次性告警；解析失败不缓存，中途注册 provider 下一请求生效。**历史注记**：v5.8 及之前「必须钉精确 (provider, model) 对」是声明层约束（agentOptions 自定义键被 dsh-tool-subagent 的 zod 剥离，省略 model 继承父模型 → UNKNOWN_MODEL）——waterfall 层可整体改写配置（kix-cost lite 回退同缝已实证），哨兵名利用 model 是自由字符串这一点做档位标记。候选池 = settings.yaml `llm-pi-ai:` 清单（pi-ai 内置目录外的模型仍需在此声明）+ 内置目录；**模型线升级现在只改 settings，preset 永不再钉模型**；插件缺失时哨兵直达适配器 → UNKNOWN_MODEL 响亮失败（宁可断不假，防静默同厂商退化）

## 机制事实 ≠ finding 成立（2026-08-07 私有项目 C PR#24）

- 实测只能证明行为真实；finding 还必须证明该行为违反了适用契约/威胁模型。契约可由仓库/PR 文档、公开 API/类型/schema、测试、调用方稳定依赖或可验证安全不变量证明；没有独立文档不等于没有契约。
- 多 agent 汇总必须分开聚合「机制 / 契约与设计意图 / 影响与严重度」，禁止跨层投票。任一独立 reviewer 基于代码/文档提出 intentional/opt-in 反证时，major+ 发布前先解析契约或问作者。
- PR#24 误报：InnerOnly 下 pathname socket 可连接的实测正确，但该显式 Codex-compatible 模式故意允许当前 UID 可达 IPC；主 reviewer 忽略 Dev/QA 与“explicit opt-in”反驳，把机制确认错升为安全 blocking。主因是聚合/严重度门禁失效，非模型能力上限。
- 已落地：review-of-review 两个跨厂商 reviewer 输出三层 YAML；每条 major+ 写 `claim_gate`，仅 mechanism/contract/impact 全部 confirmed 才能进入发布阶段。


## 实践学习不是自动立法（2026-08-07）

- 每次任务回收预期/证据/反证；无新信息不写长期记忆。单次经验只作 candidate，后续匹配任务 scoped trial，真实 pass 才 validated，反证降级/归档。
- 未匹配 trigger 不是经验真假的证据；可因上下文成本归档 stale。repo 经验不得自动晋升全局规则，需跨仓库证据或用户授权。


## 规则分层

- **通用经验** → 用户记忆 `/memories/`（跨项目适用）
- **仓库特定规则** → `.github/instructions/` + `AGENTS.md`（如端口号、模块边界、SQL 目录）
- **会话上下文** → `/memories/session/`（临时状态）


## 审查发布纪律（细节见技能，按需加载）

- 三段结构/真人简述/精简档/语言一致/不暴露方法论/不重复已发内容/API 调用纪律（POST 非幂等、emoji payload、exit 0 即成功）→ 权威定义在 `VSCODE_USER_PROMPTS_FOLDER/kixpower-review.prompt.md` §评论格式规范 + §发布纪律。发布 review 前加载该文件照抄
