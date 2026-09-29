# 昆仑任务覆盖面实测报告

**测试台**：`bench/coverage-cases.mjs`，7 类真实工作
**结果**：**21/21 全部通过**（7 类 × 3 次）
**门禁**：7/7 双向验证通过 —— 每类都有可用的参考答案，且能拒绝一个貌似合理的错误答案

---

## 1. 实测结果

```
✅ T1-write-module         从规格写模块          3/3    6s
✅ T2-fix-existing         修已有文件的 bug      3/3    9s
✅ T3-multi-file-refactor  多文件重构            3/3   14s
✅ T4-find-in-tree         在陌生目录里找东西    3/3   10s
✅ T5-run-command          跑命令并处理输出      3/3   10s
✅ T6-generate-data        生成数据文件          3/3    4s
✅ T7-debug-symptom        从现象诊断            3/3   18s

TOTAL: 21/21        平均每类 10 秒
```

**七类任务三次全部复现，没有失败。**

这七类覆盖了工具链的不同部分 —— 一个只会写代码但不会就地改文件、不会跑命令、不会产出数据文件的预设，不是通用 agent：

| 类别 | 考的是 |
|---|---|
| T1 | 纯 `write`，从文字规格产出可导入的模块 |
| T2 | `read` + `edit` 就地修 bug，不是重写 |
| T3 | 跨多文件重命名，不能漏掉引用方 |
| T4 | `grep` + `read` 在陌生树里定位正确的那个 |
| T5 | `pwsh` 跑命令，把结果落成 `JSON` |
| T6 | 产出符合 schema 的 CSV |
| T7 | 读现象、定位根因、改对地方 |

---

## 2. 过程中发现的真实缺陷

### 2.1 PowerShell 5.1 的 `-Encoding UTF8` 会写出带 BOM 的文件（**预设的真实缺口**）

测出的字节：

```
T5 产出的文件:                EF BB BF 7B 0D 0A ...
Set-Content -Encoding UTF8:    EF BB BF 7B 0D 0A
Out-File    -Encoding UTF8:    EF BB BF 7B 0D 0A
WriteAllText (no-BOM 编码器):  7B 0D 0A         ← 只有这条是干净的
本机 PowerShell: 5.1.26100.9444
```

内容完全正确，但**开头的 BOM 让 `JSON.parse` 直接抛异常**。任务看起来完成了，产物却不可用 —— 而且 BOM 在控制台里**看不出来**。

对照实验证明这不是工具的问题：用 `write` 工具、用 shell 重定向、用 node 脚本写的文件**都不带 BOM**。只有走 PowerShell 原生命令这条路会带。

**已修复**：预设新增 `Text Encoding on Windows` 规则，写明平台事实、为什么有害、以及正确写法。已验证该规则出现在 live 会话中。

### 2.2 测试台自身的 4 个错误（全部是我的）

这一轮的每一项修复都让数字更可信：

| 错误 | 症状 | 根因 |
|---|---|---|
| `turn/end` 后立即检查 | 误报"文件没写" | 最后一次工具调用的写入可能还在落盘。「文件明明在磁盘上、内容正确、时间戳还晚于检查」 |
| `JSON.stringify` 比较对象 | 键顺序不同就判失败 | JSON 对象的键序无意义，但 `stringify` 保留插入顺序。`{"cherry":1,"banana":2,"apple":3}` 被判定为不等于 `{"apple":3,"banana":2,"cherry":1}` |
| 规格未指明路径 | `counts.json` 写到 `data/` 被拒 | 放在输入旁边是**合理**的读法。已改为显式说明"项目根目录"，同时 checker 也接受相邻位置 |
| **T7 的 fixture 根本没有 bug** | 所有实现都会"通过" | 原代码已产出预期结果。**在写 checker 之前运行它才发现** |

**如果没有门禁，这些全部会变成"模型能力数据"。**

---

## 3. 关于 v4-pro 和"碾压"目标

**已放弃**。用户明确指出 v4-pro 不是未来的主攻模型，验证它没有意义。

历史事实保留在这里以免重蹈覆辙：`deepseek-official` 与 `deepseek-account` 两个渠道都返回 **HTTP 402 Insufficient Balance**，唯一能拿到 `deepseek-v4-pro` 的路径不可用；`glm-5.3` 在超过约 2000 字符的提示上挂起超过 300 秒。

**本报告不含任何模型对比结论**，因为问题不是"谁更强"，而是"昆仑能不能完成任务" —— 后者已实测通过。

---

## 4. 复现方式

不需要装昆仑，不需要 API 额度：

```powershell
cd bench
node gate-coverage.mjs      # 7 类双向门禁，纯本地
node gate-fair.mjs          # 算法题双向门禁，纯本地
node crosscheck-fair.mjs    # 28 个期望值独立复现
```

需要 harness 环境才能跑真实会话：

```powershell
$env:RUNS="3"; node run-coverage.mjs
```
