
export interface PersonEntry {
  name: string;
  description: string;
  [key: string]: string; // Allow dynamic fields
}

export interface ExtractionExample {
  input: string;
  output: string;
}

export interface ProcessingStats {
  totalParagraphs: number;
  processedParagraphs: number;
  extractedCount: number;
  startTime: number | null;
  status: 'idle' | 'parsing' | 'processing' | 'completed' | 'paused' | 'error';
  errorMessage?: string;
}

export interface SiliconFlowConfig {
  apiKey: string;
  model: string;
  temperature: number;
  batchSize: number; 
  overlapSize: number;
  maxCharacters: number;
  extractionFields: string[]; // Dynamic fields to extract
  examples: ExtractionExample[]; // Few-shot examples
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}
