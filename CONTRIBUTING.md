# Contributing

感谢参与改进播客学习助手。

## 开发流程

1. Fork仓库并从`main`创建短生命周期分支。
2. 使用Node.js 22和锁定的pnpm依赖。
3. 修改功能时同时考虑Windows与macOS路径。
4. 添加或更新自动测试。
5. 运行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

6. 提交Pull Request，说明问题、实现方式、用户影响、测试结果和平台验证边界。

## 代码与安全要求

- 不得提交API Key、Cookie、真实用户逐字稿、下载媒体、模型文件、构建产物或本机绝对路径。
- 不得移除原始稿保留、知识库证据引用或资料不足拒答等安全边界。
- 平台解析器变更应提供公开且不含个人凭据的最小测试样例。
- 第三方依赖升级需要核对许可证、来源和Windows/macOS兼容性。
- 每个功能、修复或依赖升级使用同一版本覆盖Windows与macOS，并分别说明CI与真实设备验证状态。

## 提交建议

提交信息使用简短祈使句，例如：

- `fix: resume subtitle cleanup from checkpoint`
- `feat: add publisher transcript detection`
- `docs: clarify macOS first-open steps`

