import { pick } from 'ramda';
import config from './config';
import { NHK_REQUEST_HEADERS } from './nhk';
import logger from './logger';
import { now } from './utils';

const SCHEDULE_BEGIN_OFFSET = -2 * 60 * 60 * 1000;
const SCHEDULE_END_OFFSET = 2 * 24 * 60 * 60 * 1000;
const MAX_CACHE_AGE = 60 * 60 * 1000;

let scheduleData: Array<Programme> | null = null;
let scheduleDataTimestamp = 0;

const getScheduleForPeriod = async (start: Date, end: Date): Promise<Schedule> => {
  logger.debug(`Getting schedule data for ${start.toDateString()}`);
  const finalSchedule = await getScheduleForDay(start);

  if (getEpgEndpointDate(start) !== getEpgEndpointDate(end)) {
    const cursorDate = new Date(start.valueOf());
    while (getEpgEndpointDate(cursorDate) !== getEpgEndpointDate(end)) {
      cursorDate.setDate(cursorDate.getDate() + 1);
      logger.debug(`Getting schedule data for ${cursorDate.toDateString()}`);
      let cursorDateSchedule = await getScheduleForDay(cursorDate);
      finalSchedule.data = finalSchedule.data.concat(cursorDateSchedule.data);
    }
  }

  return finalSchedule;
}

const getScheduleForDay = async (day: Date): Promise<Schedule> => {
  const scheduleEndpoint = `${config.scheduleUrl}/epg/w/${getEpgEndpointDate(day)}.json`;
  logger.debug(`Calling ${scheduleEndpoint} for data`);
  const res = await fetch(
    scheduleEndpoint,
    {
      headers: NHK_REQUEST_HEADERS
    }
  );
  
  if (!res.ok) {
    throw new Error(`Failed to fetch NHK schedule (status ${res.status} ${res.statusText})`);
  }
  
  return (await res.json()) as Schedule;
}

export const getSchedule = async (): Promise<Array<Programme>> => {
  const start = new Date(now() + SCHEDULE_BEGIN_OFFSET);
  const end = new Date(now() + SCHEDULE_END_OFFSET);
  logger.debug(`Getting schedule data from ${start.toDateString()} to ${end.toDateString()}`);

  const rawSchedule = await getScheduleForPeriod(start, end);
  const items = rawSchedule?.data;

  if (items?.length) {
    return items.map((item) => ({
      ...pick(['title', 'seriesId', 'airingId', 'description'])(item),
      subtitle: item.episodeTitle,
      thumbnail: item.episodeThumbnailUrl || item.thumbnail,
      content: item.description,
      startDate: new Date(item.startTime),
      endDate: new Date(item.endTimeReal)
    }));
  } else {
    throw new Error('Failed to retrieve schedule (missing items array)');
  }
};

export const getScheduleMemoized = async (): Promise<Array<Programme>> => {
  const cacheAge = now() - scheduleDataTimestamp;
  if (cacheAge < MAX_CACHE_AGE) {
    logger.debug(`Using cached schedule (${cacheAge / 1000} seconds old)`);
    return scheduleData;
  }

  try {
    logger.debug('Retrieving schedule');
    scheduleData = await getSchedule();
    scheduleDataTimestamp = now();

    return scheduleData;
  } catch (err) {
    logger.error('Failed to get schedule data');
    logger.error(err);

    if (scheduleData) {
      logger.info(`Falling back to old cached version (${cacheAge / 1000} seconds old)`);
      return scheduleData;
    }

    throw err;
  }
};

export const getCurrentProgramme = async (): Promise<Programme | undefined> => {
  const programmes = await getScheduleMemoized();
  const currTime = now() + config.safetyBuffer;

  const programme = programmes.find(
    ({ startDate, endDate }) => currTime > startDate.getTime() && currTime < endDate.getTime()
  );

  return programme;
};

const getEpgEndpointDate = (day: Date): string => {
  // each day contains a 24-hour period in JST (UTC+9)
  const tzFormat = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dateParts = tzFormat.formatToParts(day);
  return `${getDatePart('year', dateParts)}${getDatePart('month', dateParts)}${getDatePart('day', dateParts)}`;
}

const getDatePart = (part: string, dateParts: Array<DateTimeFormatPart>): string => {
  return dateParts.find((element) => element.type === part).value;
}
