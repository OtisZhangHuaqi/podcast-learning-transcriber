# Security Policy

## Supported versions

安全修复优先应用于最新版本。早期构建不保证收到补丁。

## Reporting a vulnerability

请使用GitHub仓库的 **Security → Report a vulnerability** 私密报告功能。不要在公开Issue中提交：

- API Key、Cookie或访问令牌；
- 可识别个人身份的逐字稿或日志；
- 可直接利用的漏洞细节。

报告应包含受影响版本、操作系统、复现步骤、影响范围和建议缓解方式。维护者确认问题前，请勿公开披露。

## Credential handling

本项目不需要在源码、`.env`、Issue或构建日志中提交DeepSeek Key。GitHub Actions构建不调用真实付费API，也不应配置用户DeepSeek凭据。

