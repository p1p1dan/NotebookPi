# Python 规范附录

> 适用：所有 Python 代码。通用原则见 common/，此处只收 Python 特有条目
> 参考来源：A Philosophy of Software Design (Ousterhout) + PEP 8/257/484 + Trellis python-design
> 级别：【规】违反报 CRITICAL/WARNING；【建】违反报 SUGGESTION

## 1. 模块设计

1. 【建】优先设计深模块：接口简单、内部实现丰富。如果调用者必须了解模块内部工作原理才能正确使用，说明模块太浅。(源:vflow, category: Pattern)
2. 【规】信息隐藏：同一个 JSON schema / 文件格式 / 迭代逻辑不应出现在多个模块中。重复出现 2 次以上的数据访问模式应提取到公共模块。(源:vflow, category: Convention)
3. 【建】复杂度向下拉：模块应内部吸收复杂度，而不是把它推给调用者。返回 `str` 而非 `subprocess.CompletedProcess`，抛具体异常而非让调用者检查 returncode。(源:vflow, category: Pattern)
4. 【建】单模块超过 ~300 行时检查是否有多个职责。按"封装了什么知识"而非"执行顺序"拆分。(源:vflow, category: Convention)
5. 【规】多模块共用的能力放 `common/`（IO / 日志 / git / 路径常量 / 数据访问），不要在各脚本内各写一份 `_read_json_file`。(源:vflow, category: Convention)

## 2. 类型优先

6. 【建】定义数据结构先于编写逻辑。先 dataclass / TypedDict，再函数签名，最后实现。(源:vflow, category: Pattern)
7. 【建】内部数据用 `@dataclass(frozen=True)`——不可变、安全传递、无意外修改。(源:vflow, category: Pattern)

```python
@dataclass(frozen=True)
class TaskInfo:
    name: str
    title: str
    status: str
    directory: Path
```

8. 【建】外部 JSON 形状用 `TypedDict` 文档化，消除散落的 `.get("field", default)` 调用。(源:vflow, category: Pattern)

```python
class TaskData(TypedDict):
    title: Required[str]
    status: Required[str]
    assignee: NotRequired[str]
```

9. 【建】两个 `str` 含义不同时用 `NewType` 区分：`TaskName = NewType("TaskName", str)`。(源:vflow, category: Pattern)
10. 【建】实体有多个互斥状态且各状态携带不同数据时，用判别联合（多个 frozen dataclass + `Union` / `match`）替代 `if data.get("status") == "running"` 式分支。(源:vflow, category: Pattern)

## 3. 命名与风格

11. 【规】模块/包名全小写加下划线：`roi_weight_table.py`。类名 PascalCase，函数/变量 snake_case。(源:PEP 8)
12. 【规】常量全大写下划线：`MAX_RETRY_COUNT`。模块级常量放文件顶部 import 之后。(源:PEP 8)
13. 【规】被其他模块 import 的函数不加 `_` 前缀——它是公共 API。仅模块内部使用才加 `_`。(源:vflow, category: Convention)
14. 【建】布尔变量/函数用 `is_`/`has_`/`can_` 前缀：`is_valid`、`has_active_task`。(源:PEP 8)

## 4. 错误处理

15. 【建】用后置条件式语义定义操作，把错误"定义掉"。(源:vflow, category: Pattern)

```python
# ❌ 前置条件式——调用者必须处理 KeyError
def remove_agent(registry, agent_id):
    if agent_id not in registry:
        raise KeyError(f"Agent {agent_id} not found")
    del registry[agent_id]

# ✅ 后置条件式——保证调用后 agent 不在 registry 中
def remove_agent(registry, agent_id):
    registry.pop(agent_id, None)
```

16. 【建】目录/文件创建用 `exist_ok=True` / `parents=True`，保证后置条件"目录存在"而非前置条件"目录不存在"。(源:vflow, category: Pattern)
17. 【规】不使用裸 `except Exception:` 吞异常。如必须捕获宽异常，至少记录日志或 re-raise。(源:vflow, category: Forbidden)
18. 【建】子进程调用封装为返回 `str`（stdout）或抛具体异常的函数，不返回 `CompletedProcess` 让调用者检查 returncode。(源:vflow, category: Pattern)

## 5. 文件与编码

19. 【规】所有 Python 文件使用 UTF-8 编码，文件头 `# -*- coding: utf-8 -*-`（仅当文件含非 ASCII 字符或需明确声明时）。(源:PEP 3120)
20. 【规】`open()` 始终显式指定 `encoding="utf-8"`。不依赖系统默认编码（Windows 上为 GBK）。(源:vflow, category: Gotcha)
21. 【规】路径操作用 `pathlib.Path`，不用 `os.path.join` 字符串拼接。(源:vflow, category: Convention)

## 6. CLI 脚本

22. 【建】CLI 脚本使用 `argparse`；子命令超过 3 个时用 `add_subparsers`。(源:vflow, category: Convention)
23. 【规】脚本如需 import 项目其他模块，在文件顶部用 `sys.path.insert(0, ...)` 并注释原因，不修改包结构。(源:vflow, category: Gotcha)
24. 【建】解析外部命令输出时注意语义空白——`strip()` 可能丢失有意义的前缀字符（如 `git submodule status` 的 ` `/`-`/`+` 前缀），用 `rstrip("\n\r")` 替代。(源:vflow, category: Gotcha)

## 7. 测试

25. 【规】测试文件命名 `test_<被测模块>.py`，放 `tests/` 目录。(源:common/testing.md)
26. 【建】测试用 `unittest` 或 `pytest`；优先 `pytest`（更简洁）。(源:vflow, category: Convention)
27. 【建】测试中的路径用 `Path(__file__).resolve().parent` 起算，不依赖 cwd。(源:vflow, category: Gotcha)

## 8. 红旗速查表（代码审查用）

| 信号 | 含义 |
| :--- | :--- |
| 浅模块 | 接口与实现一样复杂——调用者省不了事 |
| 信息泄漏 | 同一个 JSON schema / 文件格式知识散布在多个模块 |
| 重复工具函数 | 同一个 helper 在 3+ 文件里各复制一份 |
| `.get()` 链 | `data.get("x") or data.get("y", "")` — 缺类型定义 |
| `sys.path` hack | 3+ 处 `sys.path.insert` — 应考虑包结构 |
| `_` 名公共 API | `_function` 被 3+ 外部模块 import |
| 裸 dict 穿透 | 同一个 `dict` 穿过 4+ 层函数调用 — 用 dataclass |
| 宽异常捕获 | `except Exception:` 不 re-raise 也不记日志 |
