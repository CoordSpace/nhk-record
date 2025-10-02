import appRootPath from 'app-root-path';
import compareFunc from 'compare-func';
import IntervalTree from 'node-interval-tree';
import { join } from 'path';
import { init, head, last } from 'ramda';
import { Readable } from 'stream';
import config from './config';
import logger from './logger';
import { execute } from './utils';
import { writeSmartTrimConcatInstructions, remove } from './storage';

const BLACKFRAME_FILTER_OUTPUT_PATTERN = new RegExp(
  [
    /\[Parsed_blackframe_(?<filterNum>\d+) @ \w+\]/,
    /frame:(?<frame>\d+)/,
    /pblack:(?<pctBlack>\d+)/,
    /pts:\d+/,
    /t:(?<time>[\d.]+)/,
    /type:\w/,
    /last_keyframe:\d+/
  ]
    .map((r) => r.source)
    .join(' ')
);

const SILENCEDETECT_FILTER_OUTPUT_PATTERN = new RegExp(
  [
    /\[silencedetect @ \w+\]/,
    /silence_end: (?<endTime>[\d.]+) \|/,
    /silence_duration: (?<duration>[\d.]+)/
  ]
    .map((r) => r.source)
    .join(' ')
);

const CROPDETECT_FILTER_OUTPUT_PATTERN = new RegExp(
  [
    /\[Parsed_cropdetect_(?<filterNum>\d+) @ \w+\]/,
    /x1:(?<x1>\d+)/,
    /x2:(?<x2>\d+)/,
    /y1:(?<y1>\d+)/,
    /y2:(?<y2>\d+)/,
    /w:(?<width>\d+)/,
    /h:(?<height>\d+)/,
    /x:(?<x>\d+)/,
    /y:(?<y>\d+)/,
    /pts:\d+/,
    /t:(?<time>[\d.]+)/,
    /limit:[\d.]+/,
    /crop=\d+:\d+:\d+:\d+/
  ]
    .map((r) => r.source)
    .join(' ')
);

const FULL_CROP_WIDTH = 1920;

interface FrameSearchStrategy {
  name: string;
  filters: Array<number>;
  maxSkip?: number;
  minSilenceSeconds?: number;
  minFrames: number;
}

interface Silence {
  startTime: number;
  endTime: number;
}

interface BlackframeOutput {
  filterNum: number;
  frameNum: number;
  time: number;
}

const MINIMUM_BOUNDARY_SILENCE_SECONDS = 0.1;

const BOUNDARY_STRATEGIES = [
  {
    name: 'black-logo',
    filters: [11],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'white-logo',
    filters: [13],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'white-borders-logo',
    filters: [15],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'black-logo-ai-subtitles',
    filters: [17],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'black-no-logo-ai-subtitles',
    filters: [19],
    minSilenceSeconds: 1.5,
    minFrames: 5
  },
  {
    name: 'no-logo',
    filters: [20],
    minSilenceSeconds: 0.1,
    minFrames: 3
  },
  {
    name: 'newsline',
    filters: [22],
    minSilenceSeconds: 0,
    minFrames: 1
  }
] as Array<FrameSearchStrategy>;

const NEWS_BANNER_STRATEGY = {
  name: 'news-banner-background',
  filters: [13],
  maxSkip: 120,
  minFrames: 120
} as FrameSearchStrategy;

const SMARTTRIM_FILE_SUFFIX_START = '.smarttrim.start';
const SMARTTRIM_FILE_SUFFIX_MID = '.smarttrim.mid';
const SMARTTRIM_FILE_SUFFIX_END = '.smarttrim.end';
const SMARTTRIM_MIN_FRAGMENT_LENGTH_MS = 300;

const getFfprobeArguments = (path: string): Array<string> =>
  [['-v', 'quiet'], ['-print_format', 'json'], '-show_format', path].flat();

const getFfprobeKeyframeDetectArguments = (
  inputPath: string,
  start: number,
  end: number
): Array<string> => [
  ['-v', 'quiet'],
  ['-select_streams', 'v:0'],
  ['-skip_frame', 'nokey'],
  ['-show_entries', 'frame=pts_time'],
  ['-read_intervals', `${start / 1000 - 5}%+10,${end / 1000 - 5}%+10`],
  ['-print_format', 'json'],
  inputPath
].flat();

const getFfprobeBitrateArguments = (path: string): Array<string> => [
  ['-v', 'quiet'],
  ['-select_streams', 'v:0'],
  ['-show_entries', 'stream=bit_rate'],
  ['-print_format', 'json'],
  path
].flat();
  
export const getFileDuration = async (path: string): Promise<number> => {
  const args = getFfprobeArguments(path);

  logger.debug(`Invoking ffprobe with args: ${args.join(' ')}`);

  const { stdout } = await execute('ffprobe', args);
  const {
    format: { duration }
  } = JSON.parse(stdout.join(''));

  return parseFloat(duration) * 1_000;
};

export const getStreamCount = async (path: string): Promise<number> => {
  const args = getFfprobeArguments(path);

  logger.debug(`Invoking ffprobe with args: ${args.join(' ')}`);

  const { stdout } = await execute('ffprobe', args);
  const {
    format: { nb_streams: numStreams }
  } = JSON.parse(stdout.join(''));

  return parseInt(numStreams);
};

const getFfmpegBoundaryDetectionArguments = (
  path: string,
  from: number,
  limit: number
): Array<string> =>
  [
    '-copyts',
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-ss', `${from / 1000}`],
    limit ? ['-t', `${limit / 1000}`] : [],
    ['-i', path],
    ['-i', join(appRootPath.path, 'data/black_cropped.jpg')],
    ['-i', join(appRootPath.path, 'data/white_cropped.jpg')],
    ['-i', join(appRootPath.path, 'data/white_borders_cropped.jpg')],
    ['-i', join(appRootPath.path, 'data/black_cropped_aisubs.jpg')],
    ['-i', join(appRootPath.path, 'data/black_cropped_nologo_aisubs.jpg')],
    ['-i', join(appRootPath.path, 'data/newsline_intro.jpg')],
    [
      '-filter_complex',
      [
        // Extract luma channels
        '[0:V]extractplanes=y[vy]',
        '[1]extractplanes=y[by]',
        '[2]extractplanes=y[wy]',
        '[3]extractplanes=y[wby]',
        '[4]extractplanes=y[bay]',
        '[5]extractplanes=y[bnlay]',
        '[6]extractplanes=y[nly]',
        '[vy]split=outputs=2[vy0][vy1]',
        // Crop top left corner
        '[vy0]crop=w=960:h=540:x=0:y=0[cvy]',
        '[cvy]split=outputs=6[cvy0][cvy1][cvy2][cvy3][cvy4][cvy5]',
        // Detect black frames with logo
        '[cvy0][by]blend=difference,blackframe=99',
        // Detect white frames with logo
        '[cvy1][wy]blend=difference,blackframe=99:50',
        // Detect white frames with logo and border
        '[cvy2][wby]blend=difference,blackframe=99:50',
        // Detect black frames with logo and AI Subtitle text
        '[cvy3][bay]blend=difference,blackframe=99',
        // Detect black frames with no logo, with AI Subtitle text
        '[cvy4][bnlay]blend=difference,blackframe=99',
        // Detect black frames with no logo
        '[cvy5]blackframe=99',
        // Detect Newsline intro
        '[vy1][nly]blend=difference,blackframe=99',
        // Detect silences greater than MINIMUM_BOUNDARY_SILENCE_SECONDS
        `[0:a]silencedetect=n=-50dB:d=${MINIMUM_BOUNDARY_SILENCE_SECONDS}`
      ].join(';')
    ],
    ['-f', 'null'],
    '-'
  ].flat();

const findSilences = (ffmpegLines: Array<string>): Array<Silence> =>
  ffmpegLines
    .map((line) => line.match(SILENCEDETECT_FILTER_OUTPUT_PATTERN))
    .filter((x) => x)
    .map(({ groups: { endTime, duration } }) => ({
      startTime: Math.round((parseFloat(endTime) - parseFloat(duration)) * 1000),
      endTime: Math.round(parseFloat(endTime) * 1000)
    }));

const findBlackframeGroups = (
  ffmpegLines: Array<string>,
  strategy: FrameSearchStrategy,
  candidateWindows: IntervalTree<number> = new IntervalTree<number>()
): Array<DetectedFeature> =>
  ffmpegLines
    .map((line) => line.match(BLACKFRAME_FILTER_OUTPUT_PATTERN))
    .filter((x) => x)
    .map(
      ({ groups: { filterNum, frame, time } }) =>
        ({
          filterNum: parseInt(filterNum),
          frameNum: parseInt(frame),
          time: Math.round(parseFloat(time) * 1000)
        } as BlackframeOutput)
    )
    .filter(({ filterNum }) => strategy.filters.includes(filterNum))
    .filter(
      ({ time }) =>
        head(candidateWindows.search(time, time)) ?? 0 >= (strategy.minSilenceSeconds ?? 0)
    )
    .sort(compareFunc(['filterNum', 'frame']))
    .reduce((frameGroups, frame) => {
      const frameGroup = last(frameGroups) ?? [];
      if (!frameGroup.length) {
        frameGroups.push(frameGroup);
      }

      const lastFrame = last(frameGroup);
      if (
        !lastFrame ||
        (frame.frameNum - lastFrame.frameNum <= (strategy.maxSkip ?? 1) &&
          frame.filterNum === lastFrame.filterNum)
      ) {
        frameGroup.push(frame);
      } else {
        frameGroups.push([frame]);
      }
      return frameGroups;
    }, [] as Array<Array<BlackframeOutput>>)
    .filter((frameGroup) => frameGroup.length >= strategy.minFrames)
    .map(
      (frameGroup) =>
        ({
          start: head(frameGroup).time,
          end: last(frameGroup).time,
          firstFrame: head(frameGroup).frameNum,
          lastFrame: last(frameGroup).frameNum
        } as DetectedFeature)
    );

export const detectPotentialBoundaries = async (
  path: string,
  from: number,
  limit?: number
): Promise<Array<DetectedFeature>> => {
  const args = getFfmpegBoundaryDetectionArguments(path, from, limit);

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);

  const ffmpegStartTime = process.hrtime.bigint();
  const { stderr: outputLines } = await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);

  const silences = findSilences(outputLines);
  logger.debug(`Found ${silences.length} silences`, silences);
  logger.debug(`outputLines:`, outputLines);

  if (silences.length === 0) {
    logger.info('No silences of sufficient length, terminating boundary search');
    return [];
  }

  const candidateWindows = silences.reduce((tree, silence) => {
    tree.insert(silence.startTime, silence.endTime, silence.endTime - silence.startTime);
    return tree;
  }, new IntervalTree<number>());

  for (const strategy of BOUNDARY_STRATEGIES) {
    logger.debug(`Searching for candidates using ${strategy.name} strategy`);
    const candidates = findBlackframeGroups(outputLines, strategy, candidateWindows);
    logger.debug(`Found ${candidates.length} boundary candidates`, candidates);
    if (candidates.length > 0) {
      return candidates;
    }
  }

  return [];
};

const getFfmpegNewsBannerDetectionArguments = (path: string): Array<string> =>
  [
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-i', path],
    ['-i', join(appRootPath.path, 'data/news_background.jpg')],
    [
      '-filter_complex',
      [
        'nullsrc=size=184x800:r=29.97[base]',
        // Extract luma channels
        '[0:V]extractplanes=y[vy]',
        '[1]extractplanes=y[iy]',
        '[vy]split=2[vy0][vy1]',
        '[iy]split=2[iy0][iy1]',
        // Crop left and right margin areas
        '[vy0]crop=92:800:0:174[vyl]',
        '[vy1]crop=92:800:1828:174[vyr]',
        '[iy0]crop=92:800:0:174[iyl]',
        '[iy1]crop=92:800:1828:174[iyr]',
        // Compare left and right margins with news banner background
        '[vyl][iyl]blend=difference[dl]',
        '[vyr][iyr]blend=difference[dr]',
        '[base][dl]overlay=0:0:shortest=1[ol]',
        '[ol][dr]overlay=92:0,blackframe=99:16'
      ].join(';')
    ],
    ['-f', 'null'],
    '-'
  ].flat();

export const detectNewsBanners = async (path: string): Promise<Array<DetectedFeature>> => {
  const args = getFfmpegNewsBannerDetectionArguments(path);

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  const { stderr: outputLines } = await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);

  const newsBanners = findBlackframeGroups(outputLines, NEWS_BANNER_STRATEGY);
  return newsBanners;
};

const getFfmpegCropDetectionArguments = (path: string, from: number, limit: number) =>
  [
    '-copyts',
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-ss', `${from / 1000}`],
    ['-t', `${limit / 1000}`],
    ['-i', path],
    ['-i', join(appRootPath.path, 'data/news_background.jpg')],
    [
      '-filter_complex',
      [
        // Extract luma channels
        '[0:V]extractplanes=y[vy]',
        '[1]extractplanes=y[iy]',
        // Find difference with news background
        '[vy][iy]blend=difference,crop=1920:928:0:60,split=2[vc0][vc1]',
        // Mirror content to get symmetrical crop
        '[vc0]hflip[vf]',
        '[vf][vc1]blend=addition,cropdetect=24:2:1'
      ].join(';')
    ],
    ['-f', 'null'],
    '-'
  ].flat();

export const detectCropArea = async (path: string, from: number, limit: number) => {
  const args = getFfmpegCropDetectionArguments(path, from, limit);

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  const { stderr: outputLines } = await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);

  return outputLines
    .map((line) => line.match(CROPDETECT_FILTER_OUTPUT_PATTERN))
    .filter((x) => x)
    .map(({ groups: { width, time } }) => ({
      time: parseFloat(time) * 1000,
      width: parseInt(width)
    }));
};

const getFfmpegCaptureArguments = (
  path: string,
  programme: Programme,
  thumbnail: boolean,
  durationSeconds: number
): Array<string> =>
  [
    '-y',
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-i', config.streamUrl],
    ['-ss', '00:00'], // this should throw away up to five seconds of the start of the mpegts stream that comes before the first keyframe
    thumbnail
      ? [
          ['-i', '-'],
          ['-map', '0:p:1'],
          ['-map', '1'],
          ['-disposition:v:1', 'attached_pic']
        ]
      : [],
    ['-t', `${durationSeconds}`],
    ['-codec', 'copy'],
    ['-f', 'mp4'],
    programme.title ? ['-metadata', `show=${programme.title}`] : [],
    programme.subtitle ? ['-metadata', `title=${programme.subtitle}`] : [],
    programme.description ? ['-metadata', `description=${programme.description}`] : [],
    programme.content ? ['-metadata', `synopsis=${programme.content}`] : [],
    programme.startDate ? ['-metadata', `date=${programme.startDate.toISOString()}`] : [],
    programme.airingId ? ['-metadata', `episode_id=${programme.airingId}`] : [],
    ['-metadata', 'network=NHK World'],
    path
  ].flat(2);

export const captureStream = async (
  path: string,
  targetSeconds: number,
  programme: Programme,
  thumbnailData: Buffer | null
): Promise<Array<string>> => {
  const args = getFfmpegCaptureArguments(path, programme, !!thumbnailData, targetSeconds);

  const thumbnailStream = thumbnailData ? Readable.from(thumbnailData) : null;

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  const { stderr: outputLines } = await execute('ffmpeg', args, thumbnailStream);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);

  return outputLines;
};

const generateTimeSequence = (
  calcValue: (w: number) => number,
  cropParameters: Array<CropParameters>
) => {
  const { time, width = FULL_CROP_WIDTH } = last(cropParameters) ?? {};
  if (!time) {
    return `${calcValue(width)}`;
  }

  return `if(gte(t,${time / 1000}),${calcValue(width)},${generateTimeSequence(
    calcValue,
    init(cropParameters)
  )})`;
};

const calculateScaleWidth = (cropWidth: number): number =>
  Math.round((FULL_CROP_WIDTH * FULL_CROP_WIDTH) / cropWidth / 2) * 2;

const calculateOverlayPosition = (cropWidth: number): number =>
  Math.round((cropWidth - FULL_CROP_WIDTH) / 2);

const generateFilterChain = (
  start: number,
  cropParameters: Array<CropParameters>,
  hasThumbnail: boolean
): Array<string> => {
  const filters = [
    cropParameters.length > 0
      ? [
          'nullsrc=size=1920x1080:r=29.97[base]',
          `[base][0:V]overlay='${generateTimeSequence(
            calculateOverlayPosition,
            cropParameters
          )}':0:shortest=1[o]`,
          `[o]scale='${generateTimeSequence(
            calculateScaleWidth,
            cropParameters
          )}':-1:eval=frame:flags=bicubic[s]`,
          '[s]crop=1920:1080:0:0[c]'
        ]
      : [],
    hasThumbnail ? `[1:v:1]setpts=PTS+${start / 1000}/TB[tn]` : []
  ]
    .flat()
    .join(';');

  return filters ? ['-filter_complex', filters] : [];
};

const getFfmpegPostProcessArguments = (
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
  cropParameters: Array<CropParameters>,
  hasThumbnail: boolean
): Array<string> =>
  [
    '-y',
    config.threadLimit > 0 ? ['-threads', `${config.threadLimit}`] : [],
    ['-i', inputPath],
    hasThumbnail ? ['-i', inputPath] : [],
    ['-ss', `${start / 1000}`],
    end ? ['-to', `${end / 1000}`] : [],
    generateFilterChain(start, cropParameters, hasThumbnail),
    cropParameters.length > 0
      ? [
          ['-map', '[c]'],
          ['-crf', '19'],
          ['-preset', 'veryfast'],
          ['-codec:v:0', 'libx264']
        ]
      : ['-map', '0:v'],
    ['-map', '0:a'],
    ['-codec', 'copy'],
    hasThumbnail
      ? [
          ['-map', '[tn]'],
          ['-codec:v:1', 'mjpeg'],
          ['-disposition:v:1', 'attached_pic']
        ]
      : [],
    ['-map_metadata', '0'],
    ['-f', 'mp4'],
    outputPath
  ].flat(2);

export const getKeyframeBoundaries = async (
  inputPath: string,
  start: number,
  end: number
): Promise<Array<number>> => {
  const args = getFfprobeKeyframeDetectArguments(
    inputPath,
    start,
    end
  );

  logger.debug(`Invoking ffprobe with args: ${args.join(' ')}`);
  const { stdout } = await execute('ffprobe', args);
  const { frames: framesList } = JSON.parse(stdout.join(''));
  const firstKeyframe = framesList.find((frame) => (frame.pts_time * 1000) >= start);
  const lastKeyframe = framesList.findLast((frame) => (frame.pts_time * 1000) <= end);
  return [firstKeyframe.pts_time * 1000, lastKeyframe.pts_time * 1000];
}

export const getBitrate = async (
  inputPath: string
): Promise<number> => {
  const args = getFfprobeBitrateArguments(inputPath);
  logger.debug(`Invoking ffprobe with args: ${args.join(' ')}`);
  const { stdout } = await execute('ffprobe', args);
  const { streams: [
    { bit_rate: bitrate }
  ]} = JSON.parse(stdout.join(''));
  return bitrate;
}

const renderStartCap = async (
  inputPath: string,
  start: number,
  end: number,
  bitrate: number
): Promise<string|null> => {
  if (end - start < SMARTTRIM_MIN_FRAGMENT_LENGTH_MS) {
    logger.debug(`Smart trim: skipping start cap for ${inputPath} (don't render zero-length clips)`)
    return null;
  }
  const tempFilename = `${inputPath}${SMARTTRIM_FILE_SUFFIX_START}`;
  logger.info(`Smart trim: rendering start cap for ${inputPath}`);
  await renderFragment(inputPath, tempFilename, start, end, bitrate);
  return tempFilename;
}

const renderEndCap = async (
  inputPath: string,
  start: number,
  end: number,
  bitrate: number
): Promise<string|null> => {
  if (end - start < SMARTTRIM_MIN_FRAGMENT_LENGTH_MS) {
    logger.debug(`Smart trim: skipping end cap for ${inputPath} (don't render zero-length clips)`)
    return null;
  }
  const tempFilename = `${inputPath}${SMARTTRIM_FILE_SUFFIX_END}`;
  logger.info(`Smart trim: rendering end cap for ${inputPath}`);
  await renderFragment(inputPath, tempFilename, start, end, bitrate);
  return tempFilename;
}

const renderFragment = async (
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
  bitrate: number
) => {
  const args = getFfmpegRenderCapArguments(
    inputPath,
    outputPath,
    start,
    end,
    bitrate
  );

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Rendering ${outputPath} done in ${ffmpegDuration / 1_000_000n} ms`);
}

const getFfmpegRenderCapArguments = (
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
  bitrate: number
): Array<string> => [
  ['-ss', `${start / 1000}`],
  ['-i', inputPath],
  ['-ss', '0'],
  ['-t', `${(end - start) / 1000}`],
  ['-map', '0:0', '-c:0', 'libx264', '-b:0', `${bitrate}`],
  ['-map', '0:1', '-c:1', 'copy'],
  ['-video_track_timescale', '90000'],
  ['-ignore_unknown'],
  ['-f', 'mp4'],
  outputPath
].flat();

const copyMidSection = async (
  inputPath: string,
  start: number,
  end: number,
) => {
  const tempFilename = `${inputPath}${SMARTTRIM_FILE_SUFFIX_MID}`;
  logger.info(`Smart trim: copying middle section for ${inputPath}`);
  await copyFragment(inputPath, tempFilename, start, end);
  return tempFilename;
}

const copyFragment = async (
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
) => {
  const args = getFfmpegCopyFragmentArguments(
    inputPath,
    outputPath,
    start,
    end,
  );

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Rendering ${outputPath} done in ${ffmpegDuration / 1_000_000n} ms`);
}

const getFfmpegCopyFragmentArguments = (
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
): Array<string> => [
  ['-ss', `${start / 1000}`],
  ['-i', inputPath],
  ['-ss', '0'],
  ['-t', `${(end - start) / 1000}`],
  ['-map', '0:0', '-c:0', 'copy'],
  ['-map', '0:1', '-c:1', 'copy'],
  ['-video_track_timescale', '90000'],
  ['-ignore_unknown'],
  ['-f', 'mp4'],
  outputPath
].flat();

const getFfmpegConcatenationArguments = (outputPath: string, instructionsPath: string): Array<string> => [
  ['-hide_banner'],
  ['-f', 'concat'],
  ['-safe', '0'],
  ['-protocol_whitelist', 'pipe,file,fd'],
  ['-i', instructionsPath ],
  ['-map', '0:0', '-c:0', 'copy', '-disposition:0', 'default'],
  ['-map', '0:1', '-c:1', 'copy', '-disposition:1', 'default'],
  ['-movflags', '+faststart'],
  ['-default_mode', 'infer_no_subs'],
  ['-video_track_timescale', '90000'],
  ['-ignore_unknown'],
  ['-f', 'mp4'],
  outputPath
].flat();

export const concatSmartTrimFiles = async (
  outputPath: string, 
  startPath: string|null, 
  midPath: string, 
  endPath: string|null
): Promise<void> => {
  const instructionStream = new Readable();
  const instructions = [
    `file '${midPath}'`,
  ];
  if (startPath) {
    instructions.unshift(`file '${startPath}'`);
  }
  if (endPath) {
    instructions.push(`file '${endPath}'`);
  }
  logger.debug(`Smart trim: concatenating ${instructions.length} smart-trim artifacts to ${outputPath}`);
  instructions.forEach(line => {
    instructionStream.push(line);
    instructionStream.push("\n");
  });
  instructionStream.push(null);

  const instructionsPath = await writeSmartTrimConcatInstructions(outputPath, instructions);
  const args = getFfmpegConcatenationArguments(outputPath, instructionsPath);
  await execute('ffmpeg', args);
  await remove(instructionsPath);
}

const restoreSmartTrimMetadata = async (
  originalVideoPath: string,
  smartTrimVideoPath: string,
  outputPath: string,
  hasThumbnail: boolean
) => {
  const args = getFfmpegCopyMetadataArguments(
    originalVideoPath,
    smartTrimVideoPath,
    outputPath,
    hasThumbnail
  );

  logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
  const ffmpegStartTime = process.hrtime.bigint();
  await execute('ffmpeg', args);
  const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
  logger.info(`Copying metadata to ${outputPath} done in ${ffmpegDuration / 1_000_000n} ms`);
}

const getFfmpegCopyMetadataArguments = (
  originalVideoPath: string,
  smartTrimVideoPath: string,
  outputPath: string,
  hasThumbnail: boolean
): Array<string> => [
  ['-i', originalVideoPath],
  ['-i', smartTrimVideoPath],
  hasThumbnail ? [
    ['-map', '0:2', '-c', 'copy'],
  ] : [],
  ['-map', '1', '-c', 'copy'],
  ['-map_metadata', '0'],
  ['-f', 'mp4'],
  outputPath
].flat(2);

export const postProcessRecording = async (
  inputPath: string,
  outputPath: string,
  start: number,
  end: number,
  smartTrim: boolean,
  cropParameters: Array<CropParameters>
): Promise<void> => {
  const hasThumbnail = (await getStreamCount(inputPath)) > 2;
  // @TODO: "lossless" cutting outside of keyframes
  // basic idea is as follows:
  // 1. ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 input.mp4
  //    to find all keyframe time indices (or improved command below)
  //    ffprobe -v quiet -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -read_intervals [start-5]%+10,[end-5]%+10 -of json input.mp4
  //    ex. ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -read_intervals 139.311%+10,739.077%+10 '.\Rockie and Her Friends - 4034 - 016.raw' ([start] = 144.311ms, [end] = 744.077ms)
  //    [next keyframe after start] = 146.146000ms
  //    [last keyframe before end] = 742.742000ms
  // 2. ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate input.mp4
  //    to get video stream bitrate for later
  //    ex. ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate '.\Rockie and Her Friends - 4034 - 016.raw'
  //    [video bitrate] = 4590588
  //    NOTE: could take the bitrate of the output from the "copy stream" step instead? in practice it doesn't seem to affect whether the video works or not so that's good at least
  // 3. take original trim time indices (start/end), clip start-->next keyframe and last keyframe-->end
  //    ffmpeg -i input.mp4 -ss [start] -t [next keyframe timestamp after start - start] -map '0:0' '-c:0' h264 '-b:0' [bitrate of original file?] -map '0:1' '-c:1' copy -ignore_unknown -f mp4 encode-1.mp4
  //    ffmpeg -i input.mp4 -ss [last keyframe before end] -t [end - last keyframe before end] -map '0:0' '-c:0' h264 '-b:0' [bitrate of original file?] -map '0:1' '-c:1' copy -ignore_unknown -f mp4 encode-3.mp4
  //    (hopefully we don't need to set a specific codec profile for this)
  //    ex. ffmpeg -ss 144.311 -i '.\Rockie and Her Friends - 4034 - 016.raw' -ss 0 -t 1.835 -map '0:0' '-c:0' h264 '-b:0' 4590588 -map '0:1' '-c:1' copy -ignore_unknown -video_track_timescale 90000 -f mp4 encode-1.mp4
  //    ffmpeg -ss 742.742 -i '.\Rockie and Her Friends - 4034 - 016.raw' -ss 0 -t 1.335 -map '0:0' '-c:0' h264 '-b:0' 4590588 -map '0:1' '-c:1' copy -ignore_unknown -video_track_timescale 90000 -f mp4 encode-3.mp4
  // 4. copy stream between the above keyframes to new file
  //    ffmpeg -i input.mp4 -ss [next keyframe timestamp after start] -t [last keyframe before end - next keyframe before start] -map '0:0' '-c:0' copy -map '0:1' '-c:1' copy -movflags +faststart -default_mode infer_no_subs -ignore_unknown -f mp4 copy-2.mp4
  //    ex. ffmpeg -ss 146.146 -i '.\Rockie and Her Friends - 4034 - 016.raw' -ss 0 -t 596.596 -map '0:0' '-c:0' copy -map '0:1' '-c:1' copy -movflags +faststart -default_mode infer_no_subs -video_track_timescale 90000 -ignore_unknown -f mp4 copy-2.mp4
  // 5. create concat demuxer instruction file (as input.txt? what filename, should it match the input.mp4 name?):
  //    file 'encode-1.mp4'
  //    file 'copy-2.mp4'
  //    file 'encode-3.mp4'
  // 6. concat all files
  //    ffmpeg -f concat -i input.mp4 -c copy output.mp4
  //    ex. type recut.txt | ffmpeg -hide_banner -f concat -safe 0 -protocol_whitelist 'file,pipe,fd' -i - -map '0:0' '-c:0' copy '-disposition:0' default -map '0:1' '-c:1' copy '-disposition:1' default -movflags '+faststart' -default_mode infer_no_subs -ignore_unknown -video_track_timescale 90000 -f mp4 'test-recut.mp4'
  // running all this at the command line mostly works but the output.mp4 is garbled; this is probably due to codec mismatch? not sure how to re-encode
  // the cap videos to be EXACTLY the same codec/parameters as the source file
  // UPDATE 2024-07-20: IT WORKS OMG IT ACTUALLY WORKS thanks Lossless Cut for your "output last ffmpeg commands" feature!
  // notes: you need video_track_timescale, otherwise the different pieces of the concatenated video will play back at different speeds?
  // the value for video_track_timescale seems to be fixed for MPEG-TS streams at 90000

  // smart trimming: enable only if requested in the config AND there are no crop parameters
  // if there are crop parameters we're just going to re-render the whole thing anyways so might as well skip smart-trim
  if (smartTrim && cropParameters.length == 0) {
    logger.debug(`Using smart trim for ${inputPath}`);
    const temporaryPath = `${outputPath}.smarttrim.FINAL.mp4`;
    const smartTrimStartTime = process.hrtime.bigint();
    const keyframeBoundaries = await getKeyframeBoundaries(inputPath, start, end);
    const videoBitrate = await getBitrate(inputPath);
    const [ midPath, startCapPath, endCapPath ] = await Promise.all([
      copyMidSection(inputPath, keyframeBoundaries[0], keyframeBoundaries[1]),
      renderStartCap(inputPath, start, keyframeBoundaries[0], videoBitrate),
      renderEndCap(inputPath, keyframeBoundaries[1], end, videoBitrate)
    ]);
    await concatSmartTrimFiles(temporaryPath, startCapPath, midPath, endCapPath);
    await restoreSmartTrimMetadata(inputPath, temporaryPath, outputPath, hasThumbnail);
    const smartTrimDuration = process.hrtime.bigint() - smartTrimStartTime;
    logger.info(`Smart trim done in ${smartTrimDuration / 1_000_000n} ms`);
  } else {
    const args = getFfmpegPostProcessArguments(
      inputPath,
      outputPath,
      start,
      end,
      cropParameters,
      hasThumbnail
    );
  
    logger.debug(`Invoking ffmpeg with args: ${args.join(' ')}`);
    const ffmpegStartTime = process.hrtime.bigint();
    await execute('ffmpeg', args);
    const ffmpegDuration = process.hrtime.bigint() - ffmpegStartTime;
    logger.info(`Done in ${ffmpegDuration / 1_000_000n} ms`);
  }
};
