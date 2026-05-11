class VideoRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.isRecording = false;
    this.startTime = 0;
    this.duration = 0;
    this.chunks = []; // 本地缓存（上传失败时用）
    this.uploadedChunks = 0;
    this.taskId = '';
    
    // 从 URL 获取参数
    const params = new URLSearchParams(window.location.search);
    this.taskId = params.get('taskId') || this.generateTaskId();
    this.maxDuration = parseInt(params.get('duration')) || 600;
    this.userId = params.get('userId') || '';
    this.scriptId = params.get('scriptId') || '';
    
    // 【修改】云函数地址（替换为实际地址）
    this.uploadUrl = 'https://fc-mp-c5a9b0e5-b19a-49dc-875f-0e541ef48fec.next.bspapp.com/videoUpload';
    
    this.init();
  }

  generateTaskId() {
    return 'video_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  async init() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user', frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
      });
      document.getElementById('preview').srcObject = this.stream;
      document.getElementById('toggleBtn').addEventListener('click', () => this.toggle());
      this.updateStatus('摄像头已就绪');
    } catch (err) {
      this.updateStatus('摄像头启动失败: ' + err.message);
      this.notifyMiniProgram('error', { message: err.message });
    }
  }

  toggle() {
    if (this.isRecording) this.stop();
    else this.start();
  }

  start() {
    if (!this.stream) return;
    const mimeType = this.getSupportedMimeType();
    if (!mimeType) { this.updateStatus('浏览器不支持录制'); return; }

    const options = { mimeType, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
    try { this.mediaRecorder = new MediaRecorder(this.stream, options); }
    catch (err) { this.mediaRecorder = new MediaRecorder(this.stream); }

    this.chunks = [];
    this.uploadedChunks = 0;
    this.isRecording = true;
    this.startTime = Date.now();

    // 每秒输出一个片段
    this.mediaRecorder.start(1000);

    this.mediaRecorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        await this.uploadChunk(e.data);
      }
    };

    this.mediaRecorder.onstop = () => this.finalize();

    document.getElementById('toggleBtn').classList.add('recording');
    document.getElementById('toggleBtn').textContent = '停止';
    this.updateStatus('录制中...');
    this.startTimer();
    
    // 到达设定时长自动停止
    setTimeout(() => { if (this.isRecording) this.stop(); }, this.maxDuration * 1000);
    
    this.notifyMiniProgram('start', { taskId: this.taskId });
  }

  getSupportedMimeType() {
    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm'
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return null;
  }

  // 【修改】Base64 上传片段
  async uploadChunk(blob) {
    try {
      // Blob 转 Base64
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      
      const body = {
        action: 'upload',
        taskId: this.taskId,
        index: this.uploadedChunks,
        timestamp: Date.now(),
        fileData: base64,
        fileName: `chunk_${this.uploadedChunks}.webm`,
        userId: this.userId,
        scriptId: this.scriptId
      };

      const response = await fetch(this.uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      const result = await response.json();
      
      if (result.success) {
        this.uploadedChunks++;
        this.updateStatus(`已上传 ${this.uploadedChunks} 段`);
      } else {
        throw new Error(result.message || '上传失败');
      }
    } catch (err) {
      console.error('上传错误:', err);
      // 缓存本地，稍后重试
      this.chunks.push({
        index: this.uploadedChunks,
        blob,
        timestamp: Date.now()
      });
      this.uploadedChunks++;
      this.updateStatus('上传失败，已缓存');
    }
  }

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.mediaRecorder.stop();
    this.stream.getTracks().forEach(track => track.stop());
    document.getElementById('toggleBtn').classList.remove('recording');
    document.getElementById('toggleBtn').textContent = '录制';
    this.updateStatus('处理中...');
    this.stopTimer();
  }

  async finalize() {
    this.duration = Date.now() - this.startTime;
    
    // 重试缓存的片段
    for (const chunk of this.chunks) {
      try {
        const arrayBuffer = await chunk.blob.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        
        const body = {
          action: 'upload',
          taskId: this.taskId,
          index: chunk.index,
          timestamp: chunk.timestamp,
          fileData: base64,
          fileName: `chunk_${chunk.index}.webm`,
          userId: this.userId,
          scriptId: this.scriptId,
          isRetry: true
        };
        
        await fetch(this.uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (err) {
        console.error('重试上传失败:', err);
      }
    }

    // 触发合并
    try {
      const mergeRes = await fetch(this.uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'merge',
          taskId: this.taskId,
          totalChunks: this.uploadedChunks,
          duration: this.duration
        })
      });
      const mergeResult = await mergeRes.json();
      
      this.notifyMiniProgram('complete', {
        taskId: this.taskId,
        duration: this.duration,
        fileUrl: mergeResult.fileID || '',
        segments: mergeResult.segments || []
      });
    } catch (err) {
      this.notifyMiniProgram('error', { message: '合并失败: ' + err.message });
    }
  }

  startTimer() {
    this.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      document.getElementById('timer').textContent = this.formatTime(elapsed);
    }, 1000);
  }

  stopTimer() {
    clearInterval(this.timerInterval);
  }

  formatTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  updateStatus(msg) {
    document.getElementById('status').textContent = msg;
  }

  notifyMiniProgram(action, data) {
    if (window.wx && wx.miniProgram) {
      wx.miniProgram.postMessage({ data: { action, ...data, timestamp: Date.now() } });
      if (action === 'complete' || action === 'error') {
        setTimeout(() => wx.miniProgram.navigateBack(), 500);
      }
    }
  }
}

const recorder = new VideoRecorder();