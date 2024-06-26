import { mkdir, rename, stat, unlink, writeFile } from 'fs/promises';
import hasha from 'hasha';
import { join } from 'path';
import sanitizeFilename from 'sanitize-filename';
import config from './config';
import logger from './logger';

const MAX_IN_PROGRESS_AGE = 3 * 60 * 60 * 1000;

export enum FileType {
  FAILED,
  IN_PROGRESS,
  METADATA,
  POST_PROCESSED,
  RAW,
  SUCCESSFUL,
  THUMBNAIL
}

interface RecordingMetadata {
  start: Date;
  end: Date;
  trimmed?: boolean;
  cropped?: boolean;
}

export const remove = (path: string): Promise<void> => unlink(path);

const getSuffix = (suffixType: FileType, programme: Programme): string =>
  ({
    [FileType.FAILED]: (programme: Programme) =>
      `.${sanitizeFilename(programme.startDate.toISOString())}.failed`,
    [FileType.IN_PROGRESS]: () => '.inprogress',
    [FileType.METADATA]: () => '.metadata',
    [FileType.RAW]: () => '.raw',
    [FileType.SUCCESSFUL]: () => '.mp4',
    [FileType.THUMBNAIL]: () => '.jpg',
    [FileType.POST_PROCESSED]: () => '.postprocessed'
  }[suffixType](programme));

export const makeSaveDirectory = async (): Promise<string> => {
  const { saveDir } = config;
  if (!(await stat(saveDir).catch(() => null))) {
    logger.debug(`${saveDir} does not exist, attempting to create it`);
    await mkdir(saveDir, { recursive: true });
  }

  return saveDir;
};

export const getFilename = (programme: Programme): string => {
  const parts = [programme.title, programme.seriesId];

  if (programme.airingId === '000') {
    parts.push(programme.startDate.toISOString());
  } else {
    parts.push(programme.airingId);
  }

  if (programme.subtitle) {
    parts.push(programme.subtitle);
  }

  return sanitizeFilename(`${parts.join(' - ')}`).replace(/'/g, '');
};

export const getSavePath = (programme: Programme): string =>
  join(config.saveDir, getFilename(programme));

export const getInProgressPath = (programme: Programme): string =>
  `${getSavePath(programme)}${getSuffix(FileType.IN_PROGRESS, programme)}`;

export const getPostProcessedPath = (programme: Programme): string =>
  `${getSavePath(programme)}${getSuffix(FileType.POST_PROCESSED, programme)}`;

export const recordingExists = async (programme: Programme): Promise<boolean> =>
  (
    await Promise.all([
      stat(getInProgressPath(programme))
        .then((s) => Date.now() - s.mtimeMs < MAX_IN_PROGRESS_AGE)
        .catch(() => null),
        stat(`${getSavePath(programme)}${getSuffix(FileType.SUCCESSFUL, programme)}`).catch(() => null)
    ])
  ).some((s) => !!s);

export const renameWithSuffix = async (
  programme: Programme,
  fromSuffix: FileType,
  toSuffix: FileType
): Promise<string> => {
  const from = `${getSavePath(programme)}${getSuffix(fromSuffix, programme)}`;
  const to = `${getSavePath(programme)}${getSuffix(toSuffix, programme)}`;

  logger.debug(`Moving '${from}' to '${to}'`);
  try {
    await rename(from, to);
  } catch (e) {
    logger.error(`Failed to rename '${from}' to '${to}'`);
    logger.debug(e);
    return null;
  }

  return to;
};

export const renameSuccessful = (programme: Programme): Promise<string> =>
  renameWithSuffix(programme, FileType.IN_PROGRESS, FileType.SUCCESSFUL);

export const renameFailed = (programme: Programme): Promise<string> =>
  renameWithSuffix(programme, FileType.IN_PROGRESS, FileType.FAILED);

export const writeThumbnail = async (
  programme: Programme,
  thumbnailData: Buffer
): Promise<string> => {
  const path = getSavePath(programme);
  const thumbnailPath = `${path}${getSuffix(FileType.THUMBNAIL, programme)}`;

  await writeFile(thumbnailPath, thumbnailData);

  return thumbnailPath;
};

export const writeMetadata = async (
  programme: Programme,
  type: FileType,
  recording: RecordingMetadata
): Promise<string> => {
  const path = `${getSavePath(programme)}${getSuffix(type, programme)}`;
  const metadataPath = `${path}${getSuffix(FileType.METADATA, programme)}`;

  logger.debug(`Hashing '${path}'`);
  const hashStartTime = process.hrtime.bigint();
  const sha256 = await hasha.fromFile(path, { algorithm: 'sha256' });
  const hashDuration = process.hrtime.bigint() - hashStartTime;
  logger.info(`'${path}' sha256 hash is: ${sha256}, calculated in ${hashDuration / 1_000_000n} ms`);

  const metadata = JSON.stringify(
    {
      ...programme,
      recordDateStart: recording?.start?.toISOString(),
      recordDateEnd: recording?.end?.toISOString(),
      trimmed: recording?.trimmed ?? false,
      cropped: recording?.cropped ?? false,
      sha256
    },
    null,
    2
  );

  logger.debug(`Writing metadata to '${metadataPath}'`);
  await writeFile(metadataPath, metadata);

  return metadataPath;
};
