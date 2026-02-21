
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { 
  FileText, 
  Settings, 
  Play, 
  Pause, 
  Download, 
  Terminal, 
  AlertCircle, 
  CheckCircle2,
  Trash2,
  Database,
  Layers,
  Cpu,
  Type,
  Plus,
  X,
  Sparkles,
  ListPlus
} from 'lucide-react';
import { PersonEntry, ProcessingStats, SiliconFlowConfig, LogEntry } from './types';

// Global Mammoth definition from script tag
declare const mammoth: any;

const App: React.FC = () => {
  // --- State ---
  const [config, setConfig] = useState<SiliconFlowConfig>({
    apiKey: '',
    model: 'Qwen/Qwen2.5-32B-Instruct', // Changed to cheaper default
    temperature: 0.1,
    batchSize: 15,
    overlapSize: 2,
    maxCharacters: 2500, // New default character limit
    extractionFields: ['出生地', '官职'],
    examples: [],
  });

  const [paragraphs, setParagraphs] = useState<string[]>([]);
  const [results, setResults] = useState<PersonEntry[]>([]);
  const [stats, setStats] = useState<ProcessingStats>({
    totalParagraphs: 0,
    processedParagraphs: 0,
    extractedCount: 0,
    startTime: null,
    status: 'idle',
  });
  
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showExamplesModal, setShowExamplesModal] = useState(false);
  const isProcessingRef = useRef(false);
  const stopRequestedRef = useRef(false);

  // Use a ref to track unique entries for deduplication (Name + Description hash)
  const seenEntriesRef = useRef<Set<string>>(new Set());

  // --- Helpers ---
  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [{
      id: Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
      message,
      type
    }, ...prev].slice(0, 200));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStats(prev => ({ ...prev, status: 'parsing' }));
    addLog(`正在解析文档: ${file.name}...`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = result.value;
      
      const rawLines = text.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 1);
      
      setParagraphs(rawLines);
      setStats({
        totalParagraphs: rawLines.length,
        processedParagraphs: 0,
        extractedCount: 0,
        startTime: null,
        status: 'idle'
      });
      setResults([]);
      seenEntriesRef.current.clear();
      addLog(`文档解析成功，共识别到 ${rawLines.length} 个文本块`, 'success');
    } catch (error) {
      addLog(`解析文档失败: ${error}`, 'error');
      setStats(prev => ({ ...prev, status: 'error', errorMessage: '文档解析失败' }));
    }
  };

  const processBatch = async (batch: string[], retryCount = 0): Promise<PersonEntry[]> => {
    const fieldsStr = config.extractionFields.length > 0 
      ? `、${config.extractionFields.map(f => `“${f}”`).join('、')}`
      : '';
    
    const jsonStructure: Record<string, string> = {
      name: "姓名",
      description: "简介内容"
    };
    config.extractionFields.forEach(f => {
      jsonStructure[f] = f;
    });

    let examplesPrompt = '';
    if (config.examples && config.examples.length > 0) {
      examplesPrompt = `\n【参考示例】：\n${config.examples.map(ex => `输入：${ex.input}\n输出：${ex.output}`).join('\n\n')}\n`;
    }

    const prompt = `你是一个专业的历史数据分析员。下面是一些关于人物介绍的文本段落。
请从中识别出“人物姓名”、“个人简介”${fieldsStr}。

【严苛要求】：
1. 必须输出纯净的 JSON 格式。
2. 简介内容中如果包含双引号，请务必将其转换为单引号，或者进行严格转义，确保 JSON 绝对合法。
3. 如果段落不是将领人物介绍（可能是上一段的延续），请将其合并到对应人物的简介中，或者忽略无关内容。
4. 格式必须严格遵循：
{
  "data": [
    ${JSON.stringify(jsonStructure, null, 2)}
  ]
}
${examplesPrompt}
待处理文本：
${batch.join('\n---\n')}`;

    try {
      const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: config.temperature,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API HTTP ${response.status}`);
      }

      const result = await response.json();
      const rawContent = result.choices[0].message.content;
      
      try {
        const content = JSON.parse(rawContent);
        return content.data || [];
      } catch (parseError) {
        if (retryCount < 2) {
          addLog(`检测到 JSON 格式异常，正在尝试第 ${retryCount + 1} 次自动修复重试...`, 'warning');
          return await processBatch(batch, retryCount + 1);
        }
        throw parseError;
      }
    } catch (error) {
      throw error;
    }
  };

  const startProcessing = async () => {
    if (!config.apiKey) {
      addLog('请输入 API Key 以开始处理', 'error');
      return;
    }
    if (paragraphs.length === 0) {
      addLog('请先上传并解析文档', 'error');
      return;
    }

    isProcessingRef.current = true;
    stopRequestedRef.current = false;
    setStats(prev => ({ 
      ...prev, 
      status: 'processing', 
      startTime: prev.startTime || Date.now() 
    }));
    addLog(`任务启动：模型=${config.model} | 混合分段模式开启`, 'info');

    let currentIndex = stats.processedParagraphs;
    
    while (currentIndex < paragraphs.length && isProcessingRef.current) {
      if (stopRequestedRef.current) break;

      // --- Smart Hybrid Batching Logic ---
      const start = currentIndex;
      let currentBatchChars = 0;
      let end = start;
      
      // Accumulate paragraphs until limit is reached
      while (
        end < paragraphs.length && 
        (end - start) < config.batchSize && 
        currentBatchChars < config.maxCharacters
      ) {
        currentBatchChars += paragraphs[end].length;
        end++;
      }

      const batch = paragraphs.slice(start, end);
      addLog(`[正在提取] 第 ${start + 1} 至 ${end} 段 (共 ${currentBatchChars} 字)...`);
      
      const startTime = Date.now();
      
      try {
        const extracted = await processBatch(batch);
        
        const newUniqueEntries: PersonEntry[] = [];
        extracted.forEach(entry => {
          // Normalizing key to handle slight variations in extraction
          const cleanName = entry.name.trim();
          const cleanDesc = entry.description.trim();
          // Use name + first 100 chars for unique identification
          const uniqueKey = `${cleanName}_${cleanDesc.substring(0, 100)}`;
          
          if (cleanName && cleanDesc && !seenEntriesRef.current.has(uniqueKey)) {
            seenEntriesRef.current.add(uniqueKey);
            newUniqueEntries.push(entry);
          }
        });

        setResults(prev => [...prev, ...newUniqueEntries]);
        
        // Move index forward, but subtract overlap for next batch
        let nextIndex;
        if (end < paragraphs.length) {
          // If we processed very few paragraphs, overlap less
          const actualOverlap = Math.min(config.overlapSize, end - start - 1);
          nextIndex = end - Math.max(0, actualOverlap);
          
          // Safety: always move at least 1 step forward to avoid infinite loop
          if (nextIndex <= start) nextIndex = end; 
        } else {
          nextIndex = end;
        }
        
        currentIndex = nextIndex;
        setStats(prev => ({
          ...prev,
          processedParagraphs: end,
          extractedCount: seenEntriesRef.current.size
        }));

      } catch (error) {
        const firstSnippet = batch[0].substring(0, 30) + '...';
        const lastSnippet = batch[batch.length - 1].substring(0, 30) + '...';
        
        addLog(`【严重异常】批次彻底失败！已触发故障隔离`, 'error');
        addLog(`>> 失败区间：第 ${start + 1} 至 ${end} 段 (约 ${currentBatchChars} 字)`, 'error');
        addLog(`>> 首段内容：${firstSnippet}`, 'error');
        addLog(`>> 末段内容：${lastSnippet}`, 'error');
        addLog(`>> 错误原因：${error instanceof Error ? error.message : '未知错误'}`, 'error');
        addLog(`>> 续航操作：跳过此批次，将从第 ${end + 1} 段开始下一阶段任务`, 'warning');
        
        currentIndex = end;
        setStats(prev => ({ ...prev, processedParagraphs: end }));
      }

      // Dynamic cooldown based on model size and complexity
      const elapsed = Date.now() - startTime;
      const waitTime = Math.max(3000 - elapsed, 500); 
      
      if (currentIndex < paragraphs.length && isProcessingRef.current) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    if (currentIndex >= paragraphs.length) {
      setStats(prev => ({ ...prev, status: 'completed' }));
      addLog('全量数据提取任务已圆满完成！', 'success');
    } else {
      setStats(prev => ({ ...prev, status: 'paused' }));
      addLog('提取任务已由用户暂停', 'warning');
    }
    isProcessingRef.current = false;
  };

  const pauseProcessing = () => {
    stopRequestedRef.current = true;
    isProcessingRef.current = false;
  };

  const downloadCSV = () => {
    if (results.length === 0) return;
    const headers = ['姓名', '简介', ...config.extractionFields];
    const rows = results.map(r => [
      `"${r.name.replace(/"/g, '""')}"`,
      `"${r.description.replace(/"/g, '""')}"`,
      ...config.extractionFields.map(f => `"${(r[f] || '').replace(/"/g, '""')}"`)
    ]);
    const csvContent = "\uFEFF" + [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `提取数据_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addLog('CSV 文件已成功下载', 'success');
  };

  const loadDefaultExamples = () => {
    const defaultExamples = [
      {
        input: "张自忠（1891年1月11日－1940年5月16日），字荩忱，山东临清人。抗日名将，民族英雄。曾任第五战区右翼兵团总指挥、第三十三集团军总司令。",
        output: JSON.stringify({
          name: "张自忠",
          description: "张自忠（1891年1月11日－1940年5月16日），字荩忱，山东临清人。抗日名将，民族英雄。曾任第五战区右翼兵团总指挥、第三十三集团军总司令。",
          "出生地": "山东临清",
          "官职": "第五战区右翼兵团总指挥、第三十三集团军总司令"
        }, null, 2)
      },
      {
        input: "孙立人（1900年12月8日－1990年11月19日），字抚民，号仲能，安徽省庐江县人。中华民国陆军二级上将。",
        output: JSON.stringify({
          name: "孙立人",
          description: "孙立人（1900年12月8日－1990年11月19日），字抚民，号仲能，安徽省庐江县人。中华民国陆军二级上将。",
          "出生地": "安徽省庐江县",
          "官职": "陆军二级上将"
        }, null, 2)
      }
    ];
    setConfig(prev => ({ ...prev, examples: defaultExamples }));
    addLog('已加载默认微调示例', 'success');
  };

  const clearAll = () => {
    if (window.confirm('此操作将清空所有已提取数据和日志，确定吗？')) {
      setParagraphs([]);
      setResults([]);
      seenEntriesRef.current.clear();
      setStats({
        totalParagraphs: 0,
        processedParagraphs: 0,
        extractedCount: 0,
        startTime: null,
        status: 'idle'
      });
      setLogs([]);
      addLog('系统状态已完全重置');
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 font-sans">
      <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
            人物志结构化提取器
            <span className="text-emerald-600 text-xs font-bold px-2 py-1 bg-emerald-50 rounded-lg border border-emerald-100 uppercase tracking-widest">
              Smart Hybrid
            </span>
          </h1>
          <p className="text-slate-500 mt-2">
            结合 <span className="text-slate-700 font-semibold underline decoration-blue-300">字数分割</span> 与 <span className="text-slate-700 font-semibold underline decoration-blue-300">段落重叠</span> 逻辑，彻底解决长文本读取报错问题。
          </p>
        </div>
        <div className="flex gap-2">
          {stats.status === 'processing' ? (
            <button onClick={pauseProcessing} className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-amber-200">
              <Pause className="w-5 h-5" /> 暂停任务
            </button>
          ) : (
            <button onClick={startProcessing} disabled={paragraphs.length === 0 || stats.status === 'completed'} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-blue-200">
              <Play className="w-5 h-5" /> 开始提取
            </button>
          )}
          <button onClick={downloadCSV} disabled={results.length === 0} className="flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:bg-slate-300 text-white px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-green-200">
            <Download className="w-5 h-5" /> 导出结果
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2 mb-4">
              <Settings className="w-5 h-5 text-slate-500" /> 引擎与分割策略
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1 tracking-wider">API Key</label>
                <input type="password" value={config.apiKey} onChange={(e) => setConfig(prev => ({ ...prev, apiKey: e.target.value }))} className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition-all text-sm" placeholder="sk-..." />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1 tracking-wider flex items-center gap-1">
                  <Cpu className="w-3 h-3"/> 核心模型 ID
                </label>
                <input 
                  type="text" 
                  value={config.model} 
                  onChange={(e) => setConfig(prev => ({ ...prev, model: e.target.value }))} 
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none font-mono text-xs"
                  placeholder="如: Qwen/Qwen2.5-32B-Instruct"
                />
              </div>
              
              <div className="pt-2 border-t border-slate-100">
                <div className="flex justify-between items-center mb-1">
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                    <Type className="w-3 h-3"/> 单次最大字数
                  </label>
                  <span className="text-xs font-mono text-blue-600 font-bold">{config.maxCharacters} 字</span>
                </div>
                <input 
                  type="range" 
                  min="500" 
                  max="6000" 
                  step="100"
                  value={config.maxCharacters} 
                  onChange={(e) => setConfig(prev => ({ ...prev, maxCharacters: parseInt(e.target.value) }))} 
                  className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
              </div>

              <div className="pt-2 border-t border-slate-100">
                <label className="block text-xs font-bold text-slate-500 uppercase mb-2 tracking-wider flex items-center gap-1">
                  <ListPlus className="w-3 h-3"/> 结构化提取字段
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {config.extractionFields.map((field, idx) => (
                    <span key={idx} className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 px-2 py-1 rounded-md text-xs font-medium border border-blue-100">
                      {field}
                      <button 
                        onClick={() => setConfig(prev => ({ ...prev, extractionFields: prev.extractionFields.filter((_, i) => i !== idx) }))}
                        className="hover:text-red-500"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    id="newFieldInput"
                    placeholder="如: 出生地" 
                    className="flex-1 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs outline-none focus:ring-1 focus:ring-blue-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const val = (e.target as HTMLInputElement).value.trim();
                        if (val && !config.extractionFields.includes(val)) {
                          setConfig(prev => ({ ...prev, extractionFields: [...prev.extractionFields, val] }));
                          (e.target as HTMLInputElement).value = '';
                        }
                      }
                    }}
                  />
                  <button 
                    onClick={() => {
                      const input = document.getElementById('newFieldInput') as HTMLInputElement;
                      const val = input.value.trim();
                      if (val && !config.extractionFields.includes(val)) {
                        setConfig(prev => ({ ...prev, extractionFields: [...prev.extractionFields, val] }));
                        input.value = '';
                      }
                    }}
                    className="p-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-600 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-100">
                <button 
                  onClick={() => setShowExamplesModal(true)}
                  className="w-full flex items-center justify-center gap-2 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-bold transition-all border border-indigo-100"
                >
                  <Sparkles className="w-4 h-4" /> 微调示例模板 ({config.examples.length})
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1 tracking-wider">段落上限</label>
                  <input type="number" value={config.batchSize} onChange={(e) => setConfig(prev => ({ ...prev, batchSize: parseInt(e.target.value) }))} className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1 tracking-wider flex items-center gap-1">
                    <Layers className="w-3 h-3"/> 重叠段数
                  </label>
                  <input type="number" value={config.overlapSize} onChange={(e) => setConfig(prev => ({ ...prev, overlapSize: parseInt(e.target.value) }))} className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm" />
                </div>
              </div>
            </div>
          </section>

          <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2 mb-4">
              <FileText className="w-5 h-5 text-indigo-500" /> 数据导入
            </h3>
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 flex flex-col items-center justify-center bg-slate-50 hover:bg-slate-100 transition-all cursor-pointer relative group">
              <FileText className="w-12 h-12 text-slate-300 group-hover:text-indigo-400 mb-2" />
              <p className="text-sm text-slate-500 font-medium">点击或拖拽 DOCX</p>
              <input type="file" accept=".docx" onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
            </div>
            {paragraphs.length > 0 && (
              <button onClick={clearAll} className="mt-4 w-full flex items-center justify-center gap-2 text-red-500 text-xs hover:bg-red-50 py-2 rounded-lg transition-colors font-medium">
                <Trash2 className="w-4 h-4" /> 彻底重置系统
              </button>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2 mb-4">
              <Database className="w-5 h-5 text-blue-500" /> 数据统计
            </h3>
            <div className="space-y-5">
              <div>
                <div className="flex justify-between text-sm text-slate-500 mb-1.5">
                  <span>提取进度 ({stats.processedParagraphs}/{stats.totalParagraphs})</span>
                  <span className="font-mono">{stats.totalParagraphs > 0 ? ((stats.processedParagraphs/stats.totalParagraphs)*100).toFixed(1) : 0}%</span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-100">
                  <div className="bg-gradient-to-r from-blue-400 to-blue-600 h-full rounded-full transition-all duration-700 ease-out" style={{ width: `${stats.totalParagraphs > 0 ? (stats.processedParagraphs/stats.totalParagraphs)*100 : 0}%` }}></div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100/50">
                  <p className="text-[10px] text-blue-400 uppercase font-bold tracking-wider mb-1">已捕获将领</p>
                  <p className="text-3xl font-black text-blue-700 tracking-tight">{stats.extractedCount}</p>
                </div>
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200/50">
                  <p className="text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-1">去重后唯一值</p>
                  <p className="text-3xl font-black text-slate-700 tracking-tight">{results.length}</p>
                </div>
              </div>
            </div>
          </div>

          <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[420px]">
            <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <h3 className="font-bold text-slate-700 text-sm">最新提取样本 (预览前50条)</h3>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                <span className="text-[10px] text-slate-400 uppercase font-bold tracking-tighter">Live Feed</span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
              {results.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-300 gap-3">
                  <Database className="w-10 h-10 opacity-10" />
                  <p className="text-xs">等待任务启动数据流入...</p>
                </div>
              ) : (
                results.slice().reverse().slice(0, 50).map((r, i) => (
                  <div key={i} className="p-3 bg-slate-50 rounded-xl border border-slate-100 hover:border-blue-200 transition-colors">
                    <h4 className="font-bold text-blue-600 text-sm mb-1">{r.name}</h4>
                    <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-2 italic mb-2">"{r.description}"</p>
                    {config.extractionFields.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200/50">
                        {config.extractionFields.map((f, idx) => (
                          <div key={idx} className="flex flex-col">
                            <span className="text-[9px] text-slate-400 uppercase font-bold tracking-tighter">{f}</span>
                            <span className="text-[10px] text-slate-700 font-medium">{r[f] || '-'}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <section className="bg-slate-900 rounded-3xl shadow-2xl overflow-hidden flex flex-col h-full min-h-[500px] lg:min-h-0 relative border border-white/5">
          <div className="p-4 border-b border-white/10 flex justify-between items-center bg-slate-900/80 backdrop-blur sticky top-0 z-10">
            <h3 className="font-mono text-white/80 text-xs flex items-center gap-2">
              <Terminal className="w-4 h-4 text-emerald-400" /> 系统运行诊断台
            </h3>
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/30"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500/30"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/30"></div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 font-mono text-[10px] leading-relaxed space-y-2.5 custom-scrollbar-dark text-slate-400">
            {logs.length === 0 && (
              <div className="text-slate-600 text-center mt-20 italic">日志准备就绪...</div>
            )}
            {logs.map((log) => (
              <div key={log.id} className={`flex gap-3 p-1.5 rounded transition-colors ${log.type === 'error' ? 'bg-red-500/10' : log.type === 'warning' ? 'bg-amber-500/5' : ''}`}>
                <span className="text-slate-600 shrink-0 font-light opacity-50">[{log.timestamp.toLocaleTimeString([], { hour12: false })}]</span>
                <span className={`
                  ${log.type === 'error' ? 'text-red-400 font-bold' : ''}
                  ${log.type === 'success' ? 'text-emerald-400' : ''}
                  ${log.type === 'warning' ? 'text-amber-400 italic' : ''}
                  ${log.type === 'info' ? 'text-blue-300 opacity-90' : ''}
                `}>
                  {log.message}
                </span>
              </div>
            ))}
          </div>
          <div className="p-3 bg-white/5 border-t border-white/10 text-[9px] text-slate-500 flex justify-between uppercase font-mono tracking-widest">
            <span>Hybrid-Chunking: Enabled</span>
            <span>Retry-Logic: 3x</span>
          </div>
        </section>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        
        .custom-scrollbar-dark::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar-dark::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar-dark::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 10px; }
      `}} />

      {/* Examples Modal */}
      {showExamplesModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden border border-slate-200">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <div>
                <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-indigo-500" /> 微调示例模板
                </h2>
                <p className="text-xs text-slate-500 mt-1">添加示例对作为模型的“思考模版”，显著提升大批量处理时的风格一致性。</p>
              </div>
              <button onClick={() => setShowExamplesModal(false)} className="p-2 hover:bg-slate-200 rounded-full transition-colors">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
              {config.examples.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-slate-100 rounded-2xl">
                  <Sparkles className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                  <p className="text-slate-400 text-sm mb-4">暂无示例，建议加载默认模板或手动添加</p>
                  <button 
                    onClick={loadDefaultExamples}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 transition-all"
                  >
                    加载默认示例
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {config.examples.map((ex, idx) => (
                    <div key={idx} className="p-4 bg-slate-50 rounded-2xl border border-slate-200 relative group">
                      <button 
                        onClick={() => setConfig(prev => ({ ...prev, examples: prev.examples.filter((_, i) => i !== idx) }))}
                        className="absolute top-2 right-2 p-1 bg-white shadow-sm border border-slate-200 rounded-lg text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1 tracking-wider">输入文本 (段落内容)</label>
                          <textarea 
                            value={ex.input}
                            onChange={(e) => {
                              const newEx = [...config.examples];
                              newEx[idx].input = e.target.value;
                              setConfig(prev => ({ ...prev, examples: newEx }));
                            }}
                            className="w-full h-32 p-3 bg-white border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1 tracking-wider">输出 JSON (结构化结果)</label>
                          <textarea 
                            value={ex.output}
                            onChange={(e) => {
                              const newEx = [...config.examples];
                              newEx[idx].output = e.target.value;
                              setConfig(prev => ({ ...prev, examples: newEx }));
                            }}
                            className="w-full h-32 p-3 bg-white border border-slate-200 rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  <button 
                    onClick={() => setConfig(prev => ({ ...prev, examples: [...prev.examples, { input: '', output: '' }] }))}
                    className="w-full py-3 border-2 border-dashed border-slate-200 rounded-2xl text-slate-400 hover:text-indigo-500 hover:border-indigo-200 transition-all flex items-center justify-center gap-2 text-sm font-medium"
                  >
                    <Plus className="w-4 h-4" /> 添加新示例对
                  </button>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex justify-end gap-3">
              <button 
                onClick={loadDefaultExamples}
                className="px-4 py-2 text-slate-600 text-sm font-bold hover:bg-slate-200 rounded-xl transition-all"
              >
                重置为默认
              </button>
              <button 
                onClick={() => setShowExamplesModal(false)}
                className="px-6 py-2 bg-slate-800 text-white rounded-xl text-sm font-bold hover:bg-slate-900 transition-all"
              >
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
