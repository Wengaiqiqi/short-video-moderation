# 短视频内容审核

从 [EduCipher](https://github.com/Wengaiqiqi/EduCipher) 提取的独立项目。保留短视频处理、语音识别、内容审核和模型对照，不包含课堂分析、幻灯片检测或教学评分。

画面抽样和语音转写并行执行，再按讲话时间组合画面。静音时间段也会审核。桌面端默认使用云端 ASR：先用 FFmpeg 的 `silencedetect`（信号检测，非模型）按停顿把音频切成不超过单段时长的语音段，只上传有声音的段；某段识别失败时，对应窗口只按画面判断并归入待定。多个视频并行处理（默认 11 个，可调），云端 ASR 与模型请求数为全部视频共享的上限；JEV 与对照组同时运行。Jev 与 OpenAI 兼容多模态模型使用同一份输入、审核规则和阈值；对照模型仍调用 `/chat/completions`，不使用 Jev 适配器。

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

界面为深色控制台布局。左侧是任务配置（任务/模型/语音/系统）和视频队列：可多选视频或加入整个文件夹（不含子文件夹），按顺序逐个审核。中间「视频流向」图中，待审视频以封面方块逐层排进半圆；审核完成的视频化为流线，经画面切分、语音识别、分类判断落入「通过 / 拦截 / 待定」。整段视频取最严结论：任一片段被任一模型拦截即为拦截，有待定或失败片段则为待定。点击判定格可列出其中的视频，点击视频可查看逐段结果。结果只保存在当前窗口内存中，报告文件仍写入结果目录。API Key 仅保存在当前窗口内；也可设置 `TYPESAFE_API_KEY`、`LLM_API_KEY`、`MIMO_API_KEY`。默认对照模型只是示例，需填写实际使用的模型名称及地址。

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

- `desktop/src/App.tsx`：整体布局与任务表单状态。
- `desktop/src/components/FlowMap.tsx`：中间的视频流向图（半圆封面方块 → 处理阶段 → 判定格）。
- `desktop/src/components/TaskPanel.tsx`、`ModelSettings.tsx`：任务与模型/ASR/系统配置。
- `desktop/src/components/TopBar.tsx`、`Feed.tsx`、`Pipeline.tsx`、`Results.tsx`、`Detail.tsx`：指标栏与底部面板。
- `desktop/src/useModeration.ts`：后台连接、视频队列、事件流水与阶段进度；`desktop/src/lib/report.ts`：报告统计与格式化。
- `desktop/src/types.ts`：界面数据类型；`desktop/src/styles.css`：配色与布局变量。

`npm --prefix desktop run web:dev` 可在浏览器中预览界面：不在 Tauri 中运行时自动使用 `desktop/src/demo.ts` 的模拟事件和示例报告，界面处处标注 DEMO，不连接引擎也不产生真实审核结果。
- `short_video_moderation/desktop.py`：独立应用服务；`worker.py` 只负责 JSON 行协议。

修改页面不需要修改模型适配器。详细结构和协议见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。迁移范围和兼容变化见 [docs/MIGRATION.md](docs/MIGRATION.md)。

## 验证与限制

```powershell
npm test
npm run build
```

测试覆盖抽帧、语音时间段组合、静音覆盖、云端转写、模型请求结构、失败回退与输入指纹，使用合成视频及模拟 API，无需付费密钥。真实服务连通性、ASR 质量和审核准确率需另行验证。

当前示例策略仅覆盖暴力、仇恨与骚扰，阈值尚未经过数据集校准。Jev 的概率输出与多模态模型自报分数含义不同。抽样可能漏掉短暂事件；本地 ASR 使用识别片段时间戳，云端使用按停顿切分的语音段范围，均不能当作精确违规边界。短于 1 秒的窗口会并入相邻窗口；每个窗口内几乎相同的连续帧会去重（保留首帧、场景变化帧和每 2 秒一帧）。没有该模态证据的窗口记为 `skipped`，不算失败。仅画面/仅文字实验仍共用同一套语音驱动窗口，目的是固定实验输入划分。

Windows 打包入口为 `npm run dist:win`，先安装 `.[local-asr,desktop-build]`。它先打包独立 Python 引擎，再调用 Tauri 构建；FFmpeg 仍需安装或配置路径。开发启动不依赖打包后的引擎。安装包构建是独立验证步骤。
