// Types for the subset of the vendored LibMP JavaScript bundle (libmp-vendor.js,
// LibMP 1.1, MIT) that the MicroProfiler analysis uses. FlatBuffer views use
// camelCase getters; Fetch* results are plain objects with camelCase fields.
// Tick values are bigint.

export interface LibMPGlobalDesc {
  tickToMsCpu: number;
  tickToMsGpu: number;
}

export interface LibMPFrameDesc {
  frameId: number;
  frameAbsoluteId: number;
  tickStartCpu: bigint;
  tickEndCpu: bigint;
  isPaused: boolean;
  isIncomplete: boolean;
}

export interface LibMPSegmentDesc {
  timestampStart: bigint;
  timestampStop: bigint;
  frameIdBegin: number;
  frameIdEnd: number;
  frameAbsoluteIdBegin: number;
  markers: number;
}

export interface LibMPTimerDesc {
  timerId: number;
  timerName: string;
  groupId: number;
  isUserTimer?: boolean;
}

export interface LibMPGroupDesc {
  groupId: number;
  groupName: string;
}

export interface LibMPThreadDesc {
  threadId: number;
  threadName: string;
  isGpu?: boolean;
}

export interface LibMPLogIteratorState {
  frameId(): number;
  frameAbsoluteId(): number;
  threadId(): number;
  timerId(): number;
  timestamp(): bigint;
  isGpuThread(): boolean;
  isEnter(): boolean;
  isExit(): boolean;
}

export interface LibMPLogIteratorConfig {
  StartFrameId?: number;
  EndFrameId?: number;
  ThreadIds?: number[];
  GroupIds?: number[];
  SkipGpuThreads?: boolean;
  SkipEvents?: boolean;
  SkipPausedFrames?: boolean;
  SkipFrameBoundaries?: boolean;
}

export interface LibMPLogIterator {
  Configure(config: LibMPLogIteratorConfig): boolean;
  RewindTo(frameIdMin: number, frameIdMax: number): void;
  Step(): boolean;
  GetState(): LibMPLogIteratorState;
  Dispose(): void;
}

export interface LibMPSession {
  IsValid(): boolean;
  Dispose(): void;
  GetDataFormatVersion(): number;
  GetTrackCount(): number;
  FetchSegments(trackIndex: number): LibMPSegmentDesc[];
  SelectTrack(trackIndex: number): boolean;
  SelectSegment(segmentIndex: number): boolean;
  FetchGlobalDesc(): LibMPGlobalDesc | null;
  GetFrameIdMin(): number;
  GetFrameIdMax(): number;
  FetchFrameDesc(frameId: number): LibMPFrameDesc | null;
  FetchTimerIds(): number[];
  FetchThreadIds(): number[];
  FetchTimerDesc(timerId: number): LibMPTimerDesc | null;
  FetchGroupDesc(groupId: number): LibMPGroupDesc | null;
  FetchThreadDesc(threadId: number): LibMPThreadDesc | null;
  FindGroupIds(mask: string, caseSensitive?: boolean): number[];
  CreateLogIterator(): LibMPLogIterator;
}

export interface LibMPInstance {
  Session: {
    OpenFromBuffer(data: ArrayBuffer | Uint8Array, cacheSize?: number): LibMPSession | null;
  };
  Versions: { Library: number; DataFormat: number };
}

declare const LibMP: {
  create(options?: Record<string, unknown>): Promise<LibMPInstance>;
};

export default LibMP;
