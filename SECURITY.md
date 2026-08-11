# Security Policy

## Reporting a vulnerability

请不要在公开 issue 中提交未修复的安全问题。请通过 GitHub 私下联系 `musnows`，并提供复现步骤、受影响版本和可能的修复建议。

该 CLI 默认拒绝私有网络 URL，并在把远程数据发送给模型前按二进制文件头检查图片类型。配置文件可能包含 API Key，建议将 `~/.read-image-cli` 设置为 700，将 `config.json` 设置为 600。安全问题报告仍应说明是否使用了 `--allow-private-network`。
