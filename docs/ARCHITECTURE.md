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
  library.py        历史、人工终判、已审索引、设置与钥匙串、导出、标注读取
  evidence.py       片段证据、片段视频、长视频切分
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
6. 全文判断（`full_text`，非仅画面模态）：把各窗口的 `utterances` 去重后按时间编号为整段转写（`report.transcript`：`id`、`start_sec`、`end_sec`、`text`、`segments`），每组模型发一次纯文本请求，与窗口请求同时进行并最先占用请求名额；超过 12000 字时分段（重叠 3 句），分数取最高、语句取并集。结果写在 `providers.<p>.transcript`：`status`、`action`、`probabilities`、`sentences`（类别 → 语句编号，仅对照模型给出）、`windows`（这些语句所在的窗口）、`sentence_count`、`passages`、`elapsed_sec`、`usage`。它计入该组的 `usage` 与 `complete`，失败时为 `failed` / `review`，重试时只在失败或缺失时重发；全文命中拦截不触发 `stop_on_block`。
7. 前后句上下文（`speech_context`）：每个窗口的请求带上 `context_before` / `context_after`（窗口前后各一句，相距不超过 10 秒），提示词注明只用于理解语义。报告顶层记录 `full_text`、`speech_context` 两个开关，复用缓存的配置签名也包含它们。
8. 每段完成后写入 JSON 报告，结束后生成 Markdown 报告。

整段结论（界面计算，`desktop/src/lib/report.ts` 的 `videoVerdict`）：窗口取最严；全文结论加入取最严，但只有全文报出问题而窗口全部通过时归为待定（界面标注「全文」），不直接拦截。

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

界面还会发送 `{"action":"thumbnail","payload":{"id":"…","video_path":"…","ffmpeg_path":null}}` 获取封面（返回 `video.thumbnail`，含 `data_url` 或 `error`），以及 `{"action":"list_videos","payload":{"directory":"…"}}` 列出文件夹中的视频（返回 `videos.listed`，不递归）。批量审核由界面排队，界面按「并发视频」（默认 11，全局唯一的并发设置，也是云端语音与每组模型的同时请求数上限）并行发送 `moderation_start`，每个任务带 `job_id`，后台所有事件都回传 `job_id` 与 `video_path`；后台最多同时运行 32 个任务，超出返回 `moderation.rejected`。

其他命令（均带 `request_id`，回复事件带同一 `request_id`）：`moderation_evaluate`（基于已有 `inputs.json` 重新审核；`retry_failed: true` 时只重发失败窗口和失败的全文判断并合并为新报告，沿用原报告的 `full_text`、`speech_context`）、`moderation_cancel`（`job_id` 省略则取消全部，任务结束时发 `moderation.cancelled`）、`segment_evidence`、`segment_clip`、`save_review`、`list_history`、`save_settings`、`export_csv`、`split_video`、`reveal_report`（在系统文件管理器中显示报告，只接受 `moderation-*/evaluation-*/report.json` 路径）。`thumbnail` 的回复还带 `duration_sec`。结果目录下的 `index.json` 记录「文件指纹 + 配置签名 → 报告」，用于跳过已审过的视频；每个任务目录的 `review.json` 保存人工终判。策略类别可带 `label`（中文名）、`review_threshold`、`block_threshold`（覆盖全局阈值）；可选类别库在 `defaults/categories.json`。

界面根据 `moderation.progress` 的文字推断阶段：`并行处理…` 为抽帧与转写，`按讲话时间…` 为窗口对齐，`语音识别 i/N` 为云端转写进度，`<provider>: 完成 i/N` 为推理进度（N 为窗口数，开启全文判断时再加 1；两组模型同时推进）。修改这些文字时需同步 `desktop/src/useModeration.ts`。

`moderation.failed` 的 `error`：参数错误、文件不存在和 `UserFacingError`（FFmpeg 解码、云端 ASR 的 HTTP 状态等，均不含服务端响应正文）直接显示原文；其他异常只显示类型名。

事件包括 `moderation.progress`、`moderation.completed`（包含 `report`）、`moderation.failed`、`moderation.rejected`、`worker.error`、`worker.exited`。后台可同时运行多个审核任务。`completed` 表示批处理结束，单段仍可能失败，需检查各 provider 的 `complete` 和各段 `status`。

当前版本支持取消与历史结果读取，但没有持久任务队列：关闭应用后未完成的排队视频不会恢复。界面不再单独询问上传确认：开始审核即视为允许把所选模态的画面、转写（云端 ASR 时含音频）发送至已配置的服务，请求中固定发送 `upload_consent: true`。重设计页面时应继续保留失败段提示、云端时间戳精度和未校准阈值说明。JEV 与对照组 API Key 都在「模型」页填写，只在内存中传递。
