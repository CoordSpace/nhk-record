interface ScheduleItem {
  seriesId: string;
  airingId: string;
  title: string;
  episodeTitle: string;
  description: string;
  link: string;
  thumbnail: string;
  firstShow: number;
  startTime: string;
  endTime: string;
  endTimeReal: string;
  extractProgram: number;
  episodeId: string;
  episodeThumbnailUrl: string;
  episodeLink: string;
}

interface Schedule {
  data: Array<ScheduleItem>;
}

interface DateTimeFormatPart {
  type: string;
  value: string;
}