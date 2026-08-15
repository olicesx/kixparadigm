# AI 批量测试缩减方法论（跨项目通用）

## 识别 AI 批量生成的测试

```bash
# 找单 commit 添加大量测试文件的提交（批量生成的信号）
git log --diff-filter=A --name-only --pretty=format:"@@@%h|%ad|%s" --date=short -- '*_test.go'
# 再统计每个 commit 加了多少个
```
dae 实例：commit #970 一次加了 136 个测试文件（项目原本只有 17 个），占总量 90%，极度过度。

## 测试分类（按命名模式，用于删/留决策）

| 类别 | 命名 | 处理 |
|---|---|---|
| helpers | `*_test_helpers_test.go` `*_helpers_test.go` | **保留**（被引用，删了编译断） |
| bench | `*_bench_test.go` `benchmark_test.go` | 删（性能测量非行为契约） |
| fuzz | `*_fuzz_test.go` | 保留（能抓真实崩溃，用户决策） |
| 一次性验证 | `*_fix` `*_bug` `*_regression` `*_race` `*_simulation` `*_slo` | 删（针对已修bug的探索性测试） |
| integration | `*_integration` `*_e2e` | 视情况（依赖真实环境则删） |
| 功能性 | 其余 `*_test.go` | 每模块保留1-2个核心契约 |

## 功能性测试精选标准

- **KEEP**：纯逻辑/数据契约、解析、路由匹配、缓存、生命周期；确定性快速无外部依赖
- **DELETE**：依赖真实网络(net.Listen/Dial)/eBPF特权；单文件>400行(几乎肯定堆砌)；同模块重复覆盖；边缘场景

## helper 依赖链处理（最易踩坑）

保留的测试可能引用被删文件里定义的 test helper（mock 构造器等）。处理流程：
1. `go vet ./...` 编译驱动，逐个定位 `undefined: xxx`
2. `git grep -n "func xxx" HEAD~1 --` 定位原定义
3. **先排除假阳性**：`git grep -l "func xxx" HEAD~1 -- ':(exclude)*_test.go'` 若命中说明是源码构造函数（非test helper），无需恢复
4. 真 test helper 恢复到集中的 helper 文件（按包放，注意 build tag 要与使用方一致）
5. 警惕依赖链深化：恢复 helperA 发现它引用 helperB 的私有类型（如 mock struct + 方法），需一并恢复

## 删除保护（防误删原生测试）

删前用 `comm -12 delete_candidates.txt added_by_bulk_commit.txt` 取交集，**只删批量commit添加的**，原生测试绝不碰。

## 验证三件套

`go build ./...` + `go vet ./...` + `go test ./...` 必须全过。
