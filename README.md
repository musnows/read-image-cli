# @musnows/read-image-cli

一个面向终端和脚本的图片读取 CLI。它将本地图片或远程 HTTP(S) 图片送到 OpenAI Chat Completions 兼容的视觉模型，并输出图片描述或 OCR 等结果。

## 安装

```bash
npm install -g @musnows/read-image-cli
```

Node.js 版本要求为 18.17 或更高版本。可以直接使用 CLI 专用环境变量：

```bash
export READ_IMAGE_API_KEY="your-api-key"
export READ_IMAGE_BASE_URL="https://api.openai.com/v1"
export READ_IMAGE_MODEL="gpt-4o-mini"
```

也可以使用配置文件 `~/.read-image-cli/config.json`：

```json
{
  "apiKey": "your-api-key",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "prompt": "Describe this image in detail.",
  "detail": "auto",
  "maxTokens": 1024,
  "maxBytes": 20971520,
  "timeoutMs": 15000,
  "allowPrivateNetwork": false
}
```

配置文件所在目录不存在时不会报错；如果显式传入 `--config` 或设置 `READ_IMAGE_CONFIG`，但文件不存在，则会报错。配置文件包含 API Key 时建议限制权限：

```bash
mkdir -p ~/.read-image-cli
chmod 700 ~/.read-image-cli
chmod 600 ~/.read-image-cli/config.json
```

配置优先级从高到低为：命令行参数、环境变量、`~/.read-image-cli/config.json`、内置默认值。环境变量会覆盖配置文件中的同一项。

## 用法

本地路径必须是绝对路径：

```bash
read-image /absolute/path/to/image.png --json
```

也可以读取 HTTP(S) URL：

```bash
read-image "https://example.com/image" --json
```

默认请求 `POST /v1/chat/completions`，默认模型是 `gpt-4o-mini`，默认提示词是 `Describe this image in detail.`。可通过参数或 CLI 专用环境变量调整：

```bash
read-image /absolute/path/to/image.jpg \
  --prompt "Extract all visible text and preserve the original line breaks." \
  --model gpt-4o-mini \
  --detail high \
  --json
```

使用其他 OpenAI 兼容服务：

```bash
export READ_IMAGE_BASE_URL="https://api.example.com/v1"
export READ_IMAGE_MODEL="my-vision-model"
read-image "https://example.com/image" --json
```

## JSON 输出

成功时输出一个 JSON 对象：

```json
{"text":"...","model":"gpt-4o-mini","id":"chatcmpl-...","usage":{"prompt_tokens":123,"completion_tokens":20,"total_tokens":143},"image":{"source":"url","mimeType":"image/png","bytes":45678}}
```

失败时，错误 JSON 写入 stderr，退出码为 1：

```json
{"error":{"code":"UNSUPPORTED_REMOTE_IMAGE","message":"The HTTP response is not a supported raster image."}}
```

不带 `--json` 时，仅将模型文本写入 stdout；终端控制字符会被移除。

## 安全设计

- 本地输入要求是绝对路径，并且必须是普通文件。
- 图片类型通过文件内容的二进制签名识别，支持 PNG、JPEG、GIF 和 WebP，不依赖文件后缀或服务器的 `Content-Type`。
- URL 仅允许 `http://` 和 `https://`，拒绝用户名密码、`file:`、`data:` 等形式。
- URL 重定向由 CLI 手动跟随，每一跳都重新检查协议和目标地址。
- 默认拒绝解析到 localhost、私有网段、链路本地地址、云元数据常见地址和其他保留地址的 URL。
- 远程响应限制为 20 MiB，并有超时和最多 3 次重定向限制。
- 远程图片先在本地验证并转成 Data URL，再发送到模型，不把未经验证的 URL 交给模型服务端二次抓取。
- JSON 输出使用 JSON 编码；普通文本输出会清理终端控制字符，避免远程内容注入终端控制序列。

如果你明确需要访问内网图片服务，可以使用 `--allow-private-network`。该选项会关闭私网地址拦截，只应对可信 URL 使用：

```bash
read-image "http://127.0.0.1:8080/image.png" --allow-private-network --json
```

## 参数

| 参数 | 说明 |
| --- | --- |
| `--json` | 输出机器可读 JSON |
| `-p, --prompt <text>` | 图片分析提示词 |
| `-m, --model <model>` | 视觉模型 |
| `--base-url <url>` | OpenAI 兼容 API 基地址 |
| `--config <path>` | 使用指定配置文件 |
| `--detail <auto\|low\|high>` | 图片细节等级 |
| `--max-tokens <n>` | 最大输出 token 数 |
| `--max-bytes <n>` | 图片大小上限，默认 20 MiB |
| `--timeout <ms>` | 网络超时，默认 15000 毫秒 |
| `--allow-private-network` | 显式允许 URL 访问私有网络 |

环境变量：

- `READ_IMAGE_API_KEY`：可选；如果配置文件未提供 `apiKey`，则必填。
- `READ_IMAGE_BASE_URL`：可选，默认 `https://api.openai.com/v1`。
- `READ_IMAGE_MODEL`：可选，默认 `gpt-4o-mini`。
- `READ_IMAGE_CONFIG`：可选，覆盖默认配置文件路径。
- `READ_IMAGE_PROMPT`、`READ_IMAGE_DETAIL`：可选，覆盖配置文件对应字段。
- `READ_IMAGE_MAX_TOKENS`、`READ_IMAGE_MAX_BYTES`、`READ_IMAGE_TIMEOUT_MS`：可选，必须是正整数。
- `READ_IMAGE_ALLOW_PRIVATE_NETWORK`：可选，接受 `true`、`false`、`1`、`0` 等布尔值。

配置文件使用 camelCase 字段名；也接受对应的 `READ_IMAGE_*` 字段名。CLI 不读取通用的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 或 `OPENAI_MODEL` 环境变量，避免被其他工具的全局配置意外覆盖。

## 开源许可

MIT License。
