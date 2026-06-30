# 嵌入式 C 模块（可选）

> 启用条件：config.json 中 `"embedded": true`（FPGA/下位机/驱动交互代码）
> 注意：本模块部分条目与 lang/cpp.md 的 C++ 规则互斥（如全局变量），按代码所属层取用

1. 【规】嵌入式 C 允许全局变量，但必须：采用 `g+变量名` 格式（如 `gFpgaTimeInfo`）；有详细注释（功能、取值范围、存取注意事项）；尽量缩小使用范围。(源:规则32/59说明)
2. 【规】IO 接口、中断函数调用或多线程共享的变量必须定义为 volatile。(源:规则66)
3. 【规】仅本文件使用的变量/函数必须定义为 static。(源:规则65/82)
4. 【建】寄存器定义采用枚举（而非宏）。(源:建议19)
5. 【规】嵌入式源文件命名采用"设备/模块/子系统+功能"格式，如 `fpgadownloadptn.c`。(源:规则5说明)
6. 【规】嵌入式函数命名采用"模块+描述"（主语小写+谓宾驼峰）：`fpgaGetTimeInfo()`。(源:5.3节说明)
7. 【规】嵌入式常量宏采用"模块+含义"格式：`#define FPGA_DRIVER_NUM (4)`。(源:规则29说明)

## GNU C 特性（仅 GCC 工具链项目）

8. 【建】变长对象头结构可使用零长度数组：`struct VarData { int len; char data[0]; };`。(源:规则99)
9. 【建】区间 case 可用 GNU 扩展 `case '0'...'9':`。(源:规则100)
10. 【建】无副作用宏可用语句表达式 + typeof 实现：`#define min(x,y) ({ const typeof(x) _x=(x); ... })`。(源:规则101/102)
11. 【建】善用 `__attribute__`（noreturn/format/unused/aligned/packed）做编译器优化提示和检查；调试打印可用 `__FUNCTION__`。(源:规则106/105)
12. 【建】性能敏感分支可用 `__builtin_expect`（likely/unlikely）提示分支预测。(源:规则107)
