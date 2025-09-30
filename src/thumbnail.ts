import config from './config';
import { NHK_REQUEST_HEADERS } from './nhk';
import logger from './logger';

export const getThumbnail = async (thumbnailUri: string): Promise<Buffer | null> => {
  const url = `${config.assetsUrl}${thumbnailUri}`;

  logger.info(`Retrieving thumbnail: ${url}`);
  try {
    const res = await fetch(url, {
      headers: NHK_REQUEST_HEADERS
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch thumbnail (status ${res.status} ${res.statusText})`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logger.error('Failed to get thumbnail');
    logger.error(err);
  }

  return null;
};
