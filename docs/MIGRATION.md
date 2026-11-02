# 从 EduCipher 迁移

来源：`Wengaiqiqi/EduCipher` 的 `feature/short-video-moderation-jev` 工作区，基于提交 `d56c4d98664dded1d3a4404091f5b6b7488b8aa6` 及本次会话新增的短视频审核代码。

本仓库独立初始化，只迁入短视频审核核心、所需的 ASR/FFmpeg 支持、回归测试和精简桌面壳。没有迁入原项目 Git 历史、本地凭据、媒体、模型权重、运行结果、课堂队列、幻灯片检测、教学评分、旧页面或旧安装包。原 EduCipher 工作区保留。

## 接口变化

- Python 包改为 `short_video_moderation`；入口为 `python -m short_video_moderation`。
- 输入格式升级为 schema_version 2，`pages` / `page_id` 改为 `segments` / `segment_id`。旧实验输入应重新准备，不直接混用旧指纹。
- 模型与 ASR 设置独立管理，不再从课堂页面读取。
- 去除 ASR 的课堂提示词和物理术语热词。原多模态对照组保留 OpenAI 兼容请求协议，未切换到 Jev。
- 最长片段时长参数直接控制最终审核窗口，默认 8 秒。
- 桌面开发固定运行 Python 源码；仅发布包使用打包后的引擎，避免修改源码后仍运行旧引擎。

页面当前提供基础工作流，后续可以单独替换 React 组件和样式，保留 `useModeration`、类型与后台协议。
