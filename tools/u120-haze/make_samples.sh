#!/bin/sh
# Regenerate the SDR test inputs. The picture is encoded here on purpose.
# u120_haze.py then copies those video samples and adds the silent audio tail.
set -eu
cd "$(dirname "$0")/artifacts"

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=3840x2160:rate=60:duration=2" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=2" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p10le -profile:v main10 -tag:v hvc1 \
  -x265-params "bframes=0:keyint=60:min-keyint=60:scenecut=0:colorprim=1:transfer=1:colormatrix=1:range=limited:log-level=error" \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -movflags +faststart \
  hevc-main10-4k60-sdr.mp4

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=1920x1080:rate=60:duration=2" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -profile:v high -level:v 4.2 -bf 2 -g 60 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  avc-1080p60-sdr.mp4

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=1280x720:rate=60:duration=1" \
  -f lavfi -i "sine=frequency=660:sample_rate=48000:duration=1" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -profile:v high -bf 0 -g 30 \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -c:a aac -b:a 160k -ar 48000 -ac 2 \
  -movflags +faststart \
  avc-720p60-sdr.mp4
