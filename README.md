# Drama Harvester (24/7 Cloud Automated Engine)

Automated multi-platform drama harvester engine powering ChineseStory CDN and database.

### Platforms Supported:
- Melolo
- NetShort
- DramaBox
- PineWave
- ReelTales
- ShortMax
- StarDust
- FlexTV

### Core Engine Features:
- Sequential Round-Robin across all platforms with de-duplication
- 100% Publishing Gate (unarchive only when 100% episodes are in Telegram CDN)
- Hardware-compatible FFmpeg transcoding (yuv420p + faststart)
- Automated softsub and hardsub processing
- Dynamic Bitrate Cap (< 19.5 MB Telegram Limit)
- State persistence and self-healing audit queue
