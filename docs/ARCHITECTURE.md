# 项目结构与界面接口

```text
short_video_moderation/
  pipeline.py       准备输入、模型对照、报告与 CLI
  sampling.py       定时和场景变化抽帧
  alignment.py      语音驱动窗口，保留静音覆盖
  transcription.py  本地 ASR 与音频块转写整理
  cloud_asr.py      MiMo 云端转写、静音切分与并发控制
  limits.py         全部视频共享的请求上限
  errors.py         可直接显示给用户的错误
  providers.py      Jev、OpenAI 兼容多模态适配器
  desktop.py        桌面应用服务
  worker.py         JSON 行通信
  defaults/         无密钥的示例规则与配置
desktop/            React 界面和 Tauri 原生壳
tests/              核心、ASR 与 worker 回归测试
```

## 数据流

1. 读取视频元数据，检查时长上限。
2. 两个线程并行完成抽帧和转写。本地 ASR 识别整段音轨；云端 ASR 先整段解码一次，用 `silencedetect` 找停顿（-35 dB / 0.3 s），把语音切成不超过单段时长的块（连续声音在 -25 dB 的低谷处切，仍找不到才定长切），纯静音块不上传，失败块不中断整个视频。
3. 按 ASR 时间戳建立窗口；静音处补齐窗口，短于 1 秒的窗口并入相邻窗口，长段平均切分，帧数超预算时按帧数平分。之后在每个窗口内对几乎相同的连续帧去重（结构哈希 + 颜色缩略图，保留首帧与每 2 秒一帧）。
4. 保存 `inputs.json`（schema_version 2）与图片指纹。时间段数组为 `segments`，编号为 `segment_id`。
5. 各模型并发推理（每组请求数受共享上限控制，429 时遵循 `Retry-After`），共用相同图片、转写和策略。某模型失败不阻止另一组完成；失败段进入人工复核，报告中记录错误代码（如 `http_401`、`timeout`）。没有该模态证据的窗口为 `skipped`；语音识别失败的窗口只按画面判断，并至少归入复核（`evidence: asr_failed`）。
6. 每段完成后写入 JSON 报告，结束后生成 Markdown 报告。

## 桌面协议

前端监听 Tauri `worker-event`，注册完成后调用 `send_worker_command`。

```json
{"action":"initialize"}
```

返回 `worker.ready`，其中 `settings` 提供无密钥的默认设置。

```json
{
  "action":"moderation_start",
  "payload": {
    "video_path":"D:/videos/sample.mp4",
    "output_root":"D:/Codex data/tmp/short-video-moderation/results",
    "provider":"both",
    "modality":"multimodal",
    "jev_key":"",
    "interval":0.5,
    "segment_seconds":8,
    "settings":{},
    "upload_consent":true
  }
}
```

`settings` 与 `desktop/src/types.ts` 的 `Settings` 对应。模型密钥可从当前进程环境读取；用户填写时只通过内存传递，不写入设置或报告。

界面还会发送 `{"action":"thumbnail","payload":{"id":"…","video_path":"…","ffmpeg_path":null}}` 获取封面（返回 `video.thumbnail`，含 `data_url` 或 `error`），以及 `{"action":"list_videos","payload":{"directory":"…"}}` 列出文件夹中的视频（返回 `videos.listed`，不递归）。批量审核由界面排队，界面按「同时处理视频数」（默认 11）并行发送 `moderation_start`，每个任务带 `job_id`，后台所有事件都回传 `job_id` 与 `video_path`；后台最多同时运行 32 个任务，超出返回 `moderation.rejected`。

界面根据 `moderation.progress` 的文字推断阶段：`并行处理…` 为抽帧与转写，`按讲话时间…` 为窗口对齐，`语音识别 i/N` 为云端转写进度，`<provider>: 完成 i/N` 为逐段推理进度（两组模型同时推进）。修改这些文字时需同步 `desktop/src/useModeration.ts`。

`moderation.failed` 的 `error`：参数错误、文件不存在和 `UserFacingError`（FFmpeg 解码、云端 ASR 的 HTTP 状态等，均不含服务端响应正文）直接显示原文；其他异常只显示类型名。

事件包括 `moderation.progress`、`moderation.completed`（包含 `report`）、`moderation.failed`、`moderation.rejected`、`worker.error`、`worker.exited`。后台可同时运行多个审核任务。`completed` 表示批处理结束，单段仍可能失败，需检查各 provider 的 `complete` 和各段 `status`。

当前版本没有任务取消、跨窗口恢复或持久任务队列。界面不再单独询问上传确认：开始审核即视为允许把所选模态的画面、转写（云端 ASR 时含音频）发送至已配置的服务，请求中固定发送 `upload_consent: true`。重设计页面时应继续保留失败段提示、云端时间戳精度和未校准阈值说明。JEV 与对照组 API Key 都在「模型」页填写，只在内存中传递。
