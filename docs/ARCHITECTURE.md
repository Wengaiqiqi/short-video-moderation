# 项目结构与界面接口

```text
short_video_moderation/
  pipeline.py       准备输入、模型对照、报告与 CLI
  sampling.py       定时和场景变化抽帧
  alignment.py      语音驱动窗口，保留静音覆盖
  transcription.py  本地 ASR 与音频块转写整理
  cloud_asr.py      MiMo 云端转写与并发控制
  providers.py      Jev、OpenAI 兼容多模态适配器
  desktop.py        桌面应用服务
  worker.py         JSON 行通信
  defaults/         无密钥的示例规则与配置
desktop/            React 界面和 Tauri 原生壳
tests/              核心、ASR 与 worker 回归测试
```

## 数据流

1. 读取视频元数据，检查时长上限。
2. 两个线程并行完成抽帧和转写；本地 ASR 识别整段音轨，云端 ASR 独立按 30 秒音频块请求。
3. 按 ASR 时间戳建立窗口；静音处补齐窗口，长段按时长及帧数预算细分。
4. 保存 `inputs.json`（schema_version 2）与图片指纹。时间段数组为 `segments`，编号为 `segment_id`。
5. 各模型独立推理，共用相同图片、转写和策略。某模型失败不阻止另一组完成；失败段进入人工复核。
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

界面还会发送 `{"action":"thumbnail","payload":{"id":"…","video_path":"…","ffmpeg_path":null}}` 获取封面（返回 `video.thumbnail`，含 `data_url` 或 `error`），以及 `{"action":"list_videos","payload":{"directory":"…"}}` 列出文件夹中的视频（返回 `videos.listed`，不递归）。批量审核由界面排队，后台仍一次只运行一个审核任务；`moderation.completed` 和 `moderation.failed` 附带 `video_path`。

界面根据 `moderation.progress` 的文字推断阶段：`并行处理…` 为抽帧与转写，`按讲话时间…` 为窗口对齐，`<provider>: 片段 i/N` 为逐段推理进度。修改这些文字时需同步 `desktop/src/useModeration.ts`。

事件包括 `moderation.progress`、`moderation.completed`（包含 `report`）、`moderation.failed`、`moderation.rejected`、`worker.error`、`worker.exited`。同一后台一次运行一个审核任务。`completed` 表示批处理结束，单段仍可能失败，需检查各 provider 的 `complete` 和各段 `status`。

当前版本没有任务取消、跨窗口恢复或持久任务队列。重设计页面时应继续保留失败段提示、上传确认、云端时间戳精度和未校准阈值说明。
