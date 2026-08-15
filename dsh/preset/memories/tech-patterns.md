# 跨项目技术模式速查（Windows / Unity / 开发工具）

## Windows 系统 / 驱动 / 安全软件修复

- **本地 HTTPS 单文件 EXE**：优先内嵌证书 PEM，启动时按 thumbprint 检测并导入 CurrentUser\Root，避免要求管理员权限
- **WinForms + WebView2 关闭流程**：避免在 `FormClosing` 里对 `ExecuteScriptAsync()` / 异步备份做 `.GetAwaiter().GetResult()`；用"先 Cancel，异步收尾，再二次 Close + FormClosed 清理"避免卡死重入
- **WebView2 自定义环境参数**（`--disable-gpu` 等）会传到共享 `msedgewebview2.exe`，可能导致其他 WebView 应用崩溃。正式版默认不传任何额外参数；`--remote-debugging-port` 仅 `--webview-debug` 按需开
- **UWP/MSIX "去高级选项修复"**：先查 `Microsoft-Windows-AppModel-Runtime/Admin` 是否 `0x3CFC`/激活失败，再 `wsreset` + 当前用户 `Get-AppxPackage` 重注册；`0x80073D02` 多数是包占用非损坏，看最终 `Status=Ok`
- **"优化脚本"误伤**：常把 `wscsvc`/`SecurityHealthService`/`DPS`/`WSearch`/`SysMain`/`WinDefend` 设 Disabled。诊断先查这些服务 + `PendingFileRenameOperations` 是否堆厂商管家残留
- **EasyAntiCheat "参数错误"**：qa-factory-reset 完全清理 → 用游戏目录 `EasyAntiCheat_EOS_Setup.exe` 重新 install ProductId（`Start-Process -Verb RunAs -Wait`）。.sys 驱动由 Bootstrapper 动态下载，无需预装
- **卡巴斯基旧版致 TLS 10013**：加密连接扫描驱动与 Windows 代码完整性冲突 → 卸载/升级 + `netsh winsock reset`
- **WMI/WmiPrvSE 高占用根因 = 杀软卸载残留**（实测）：卡巴/联想管家程序已卸但残留 Defender 策略键污染 + 蓝牙驱动框架损坏 → gpsvc 狂查蓝牙 → WMI 配额违反 0x80041032（5858 爆发）。修复：删 Defender 策略键 + `pnputil` 移除蓝牙设备 + winsock reset + 重启
- **Schannel 36871/10013 持续 = 根证书存储被污染**：根证书 >100 即可疑，按 Subject 过滤企业拦截根（深信凡 Sangfor）+ 自签证书移除。注意 HTTPS 实测能连通，10013 多数是良性噪音
- **蓝牙设备移除正确工具**：`Remove-PnpDevice` 在 32 位 Windows PowerShell 不可用，改用 `pnputil /enum-devices /class Bluetooth` + `pnputil /remove-device "<InstanceId>"`（/force 兜底）
- **联想百应/火绒残留致 EAC 游戏闪退**（坦克世界实测）：主程序卸载后留 200+MB 缓存 + 注册表残留，且禁用 Defender 所有服务不恢复。EAC 在裸奔+残留下拒绝加载 → 无声闪退无 dump。修复：`reg delete HKLM\SOFTWARE\Policies\Microsoft\Windows Defender /f` + `sc config WinDefend start= auto` + `Set-MpPreference -DisableRealtimeMonitoring $false` + 删 Lenovo\baiying 目录。修复后必须重启
- **提权脚本 UAC 卡死**：用户不可用/无桌面交互时 UAC 弹窗会等待被取消（ExitCode 1）。改用桌面 .bat 自提权（`Start-Process -Verb RunAs` 自调用）+ 末尾 pause，让用户回来双击，而非 chat 终端同步等待
- **游戏 dev 版 vulkan-1.dll**（1.3.281 Dev）不可替换为系统版（1.4.341），否则"应用程序无法正常启动"

## Unity IL2CPP / BepInEx 游戏调试

- **IL2CPP 调试菜单必须 BepInEx 6.0.0-pre.2**（5.x 不支持），插件目标 `net6.0`（非 netstandard），引用 `BepInEx/interop/*.dll` 桩（非 unity-libs）。完整技能见 `unity-il2cpp-debug-menu`
- **IL2CPP interop GUI 陷阱**：`GUILayout.BeginArea/EndArea` 异常会永久损坏 GUIClip 栈 → 每帧 `Stack empty` 刷屏，try-finally 救不回。**改用纯 `GUI.Box/GUI.Button` 静态坐标**
- **IL2CPP 反射限制**：`System.Reflection` 对**静态属性**返回 null（实例 OK），需访问静态属性时**编译时直接绑定**
- **IL2CPP `FindObjectOfType<T>()` 报 CS0311**：用非泛型版 `FindObjectOfType(Il2CppType.Of<T>()).TryCast<T>()`
- **IL2CPP 嵌套 MonoBehaviour**：必须 `ClassInjector.RegisterTypeInIl2Cpp<T>()` 后才能 `AddComponent`
- **IL2CPP `GUI.Window` 的 `WindowFunction` 委托**不能用 C# lambda 赋值（CS1503），避开整个 `GUI.Window` API
- **IL2CPP 元数据分析**：用 Mono.Cecil **0.11.5 NuGet**（非 BepInEx 自带 MonoMod fork，API 不兼容）。IL2CPP DLL 方法 body 是空的，只能读元数据
- **BepInEx 6 IL2CPP 首次启动慢**（5-15 分钟）：Cpp2IL 解析 + 生成桩。让用户启动到主菜单后关闭
- **VContainer DI Manager 类常非 MonoBehaviour**：`FindObjectOfType` 无效，需通过 MonoBehaviour 链反查
- **游戏内置 SROptions** 往往是开发者作弊控制台：调 `SROptions.Current` 单例方法比反射字段稳定
- **商店商品锁定**：通常在 `InventoryMerchandiseSettings.IsLocked/IsBlocked`，直接清空 `lockedCheckerGroup = null` 全解锁
- **BepInEx 部署 DLL 被占用**（游戏运行中）：复制到 `.dll.new` 后缀，等关闭后 `Move-Item .dll.new .dll -Force`
- **游戏自带 Harmony/MonoMod mod 系统时不要装 BepInEx**：doorstop 注入会让 HarmonyX 版 `MonoMod.Utils.dll` 污染程序集解析顺序，游戏原生 mod 系统报 `MissingMethodException`。诊断看 Unity `Player.log`。优先用开发者内置命令行开关（如太吾 `--enable-gm`）

## 开发工具 / MCP

- **CodeGraphy MCP（已弃用，2026-06-29 卸载）**：依赖 tree-sitter 原生模块，Node 24 强制 C++20 但 binding.gyp 写死 /std:c++17 → `error C1189`。**必须切 Node 22 LTS**
- **CodeGraphy 官方 plugin 仅 7 种语言**（godot/markdown/particles/svelte/typescript/unity/vue），**无 C#/Python/Java/Go**。即使全局装 tree-sitter-c-sharp 也无效
- **.NET / C# 项目不要装 CodeGraphy**：依赖分析直接用 `vscode_listCodeUsages`（Roslyn 原生，比 tree-sitter 准，理解泛型/partial class/extension method）+ `grep_search` 降级
