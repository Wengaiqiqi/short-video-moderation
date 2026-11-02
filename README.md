# 短视频内容审核

从 [EduCipher](https://github.com/Wengaiqiqi/EduCipher) 提取的独立项目。保留短视频处理、语音识别、内容审核和模型对照，不包含课堂分析、幻灯片检测或教学评分。

画面抽样和语音转写并行执行，再按讲话时间组合画面。静音时间段也会审核。Jev 与 OpenAI 兼容多模态模型使用同一份输入、审核规则和阈值；对照模型仍调用 `/chat/completions`，不使用 Jev 适配器。

## 本地开发

需要 Python 3.10+、Node.js 20+、FFmpeg/ffprobe；桌面开发还需要 Rust、Windows C++ 构建工具和 WebView2。FFmpeg 可加入 PATH，也可在界面指定路径。

在项目根目录执行（Windows PowerShell）：

```powershell
$env:TEMP = 'D:\Codex data\tmp'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = 'D:\Codex data\home\.cache\pip'
python -m pip install -e '.[local-asr]'
npm run setup
npm run dev
```

只用云端 ASR 或无声视频时，可用 `python -m pip install -e .`，无需安装本地 ASR 依赖。`PYTHON` 环境变量可指定桌面后台使用的 Python 解释器。

`npm run setup` 将前端依赖安装在运行目录，通过目录链接连接源码；Windows 默认运行目录为 `D:\Codex data\tmp\short-video-moderation`，缓存目录为 `D:\Codex data\home\.cache`。`SVM_RUNTIME_ROOT`、`SVM_CACHE_ROOT` 可覆盖这些路径。桌面开发端口为 `5174`。前端单独构建使用 `npm run build`。

界面目前提供视频/输出目录选择、两组模型配置、ASR 配置、单模态对照和报告查看。API Key 仅保存在当前窗口内；也可设置 `TYPESAFE_API_KEY`、`LLM_API_KEY`、`MIMO_API_KEY`。默认对照模型只是示例，需填写实际使用的模型名称及地址。

## 命令行

先准备输入，再对同一份输入执行审核或消融实验：

```powershell
python -m short_video_moderation prepare 'D:\videos\sample.mp4' --output 'D:\Codex data\tmp\short-video-moderation\sample' --asr-config short_video_moderation/defaults/asr.json
python -m short_video_moderation evaluate 'D:\Codex data\tmp\short-video-moderation\sample\inputs.json' --provider both
python -m short_video_moderation evaluate 'D:\Codex data\tmp\short-video-moderation\sample\inputs.json' --provider both --modality visual
python -m short_video_moderation evaluate 'D:\Codex data\tmp\short-video-moderation\sample\inputs.json' --provider both --modality text
```

无音轨视频可省略 `--asr-config`。输入目录必须是新目录，避免覆盖已有实验输入。`--interval` 控制定时抽帧间隔，`--segment-seconds` 控制最终审核窗口最长时长（默认 8 秒），超过帧数预算时进一步分段。

审核策略与模型默认配置在 `short_video_moderation/defaults/moderation.json`，支持 `evaluate --config <配置文件>`。报告输出 `report.json`、`report.md`，记录输入/策略指纹、实际模型、用量、耗时和每段结果。修改已准备的输入或图片会拒绝执行，避免对照实验使用不同证据。

## 页面重设计入口

- `desktop/src/App.tsx`：任务页面与布局。
- `desktop/src/components/ModelSettings.tsx`、`Results.tsx`：配置和结果组件。
- `desktop/src/useModeration.ts`：后台连接与任务状态。
- `desktop/src/types.ts`：界面数据类型。
- `short_video_moderation/desktop.py`：独立应用服务；`worker.py` 只负责 JSON 行协议。

修改页面不需要修改模型适配器。详细结构和协议见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。迁移范围和兼容变化见 [docs/MIGRATION.md](docs/MIGRATION.md)。

## 验证与限制

```powershell
npm test
npm run build
```

测试覆盖抽帧、语音时间段组合、静音覆盖、云端转写、模型请求结构、失败回退与输入指纹，使用合成视频及模拟 API，无需付费密钥。真实服务连通性、ASR 质量和审核准确率需另行验证。

当前示例策略仅覆盖暴力、仇恨与骚扰，阈值尚未经过数据集校准。Jev 的概率输出与多模态模型自报分数含义不同。抽样可能漏掉短暂事件；本地 ASR 使用识别片段时间戳，云端使用音频块范围，均不能当作精确违规边界。仅画面/仅文字实验仍共用同一套语音驱动窗口，目的是固定实验输入划分。

Windows 打包入口为 `npm run dist:win`，先安装 `.[local-asr,desktop-build]`。它先打包独立 Python 引擎，再调用 Tauri 构建；FFmpeg 仍需安装或配置路径。开发启动不依赖打包后的引擎。安装包构建是独立验证步骤。
