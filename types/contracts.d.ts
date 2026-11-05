export type SessionState = 'in_scope' | 'out_of_scope' | 'unknown';
export type Category = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
export type Decision = 'allow' | 'deny' | 'unknown';

export interface GateInput {
  sessionId: string;
  currentMessage: string;
  recentMessages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  sessionState: SessionState;
  attachmentTypes?: ReadonlyArray<string>;
}

export interface GateDecision {
  decision: Decision;
  category: Category;
  reason: string;
  confidence: number;
}

export interface ConfigProvider<TConfig> {
  load(): Promise<TConfig>;
}

export interface AuditWriter<TEvent> {
  write(event: TEvent): Promise<void>;
}
