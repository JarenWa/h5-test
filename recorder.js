class VideoRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.isRecording = false;
    this.startTime = 0;
    this.duration = 0;
    this.chunks = [];
    this.uploadedChunks = 0;
    this.taskId = '';
    
    const params = new URLSearchParams(window.location.search);
    this.taskId = params.get('taskId') || this.generateTaskId();
    this.maxDuration = parseInt(params.get('duration')) || 600;
    this.userId = params.get('userId') || '';
    this.scriptId = params.get('scriptId') || '';
    
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

    const options = { mimeType, videoBitsPerSecond: 2500000, audioBitsPerRate: 128000 };
    try { this.mediaRecorder = new MediaRecorder(this.stream, options); }
    catch (err) { this.mediaRecorder = new MediaRecorder(this.stream); }

    this.chunks = [];
    this.uploadedChunks = 0;
    this.isRecording = true;
    this.startTime = Date.now();

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

  // 【修复】使用 XMLHttpRequest + 安全的 Base64 编码
  async uploadChunk(blob) {
    try {
      // Blob 转 ArrayBuffer
      const arrayBuffer = await blob.arrayBuffer();
      
      // 【修复】安全的 Base64 编码（处理所有二进制数据）
      const base64 = this.arrayBufferToBase64(arrayBuffer);
      
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

      // 【修复】使用 XMLHttpRequest 替代 fetch（WebView 兼容性更好）
      const result = await this.xhrPost(this.uploadUrl, body);
      
      if (result.success) {
        this.uploadedChunks++;
        this.updateStatus(`已上传 ${this.uploadedChunks} 段`);
      } else {
        throw new Error(result.message || '上传失败');
      }
    } catch (err) {
      console.error('上传错误:', err);
      this.chunks.push({
        index: this.uploadedChunks,
        blob,
        timestamp: Date.now()
      });
      this.uploadedChunks++;
      this.updateStatus('上传失败，已缓存: ' + err.message);
    }
  }

  // 【新增】安全的 ArrayBuffer 转 Base64
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // 【新增】XMLHttpRequest POST（WebView 兼容）
  xhrPost(url, data) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            resolve(result);
          } catch (err) {
            reject(new Error('解析响应失败: ' + xhr.responseText));
          }
        } else {
          reject(new Error('HTTP ' + xhr.status + ': ' + xhr.statusText));
        }
      };
      
      xhr.onerror = () => reject(new Error('网络请求失败'));
      xhr.ontimeout = () => reject(new Error('请求超时'));
      
      xhr.send(JSON.stringify(data));
    });
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
        const base64 = this.arrayBufferToBase64(arrayBuffer);
        
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
        
        await this.xhrPost(this.uploadUrl, body);
      } catch (err) {
        console.error('重试上传失败:', err);
      }
    }

    // 触发合并
    try {
      const mergeResult = await this.xhrPost(this.uploadUrl, {
        action: 'merge',
        taskId: this.taskId,
        totalChunks: this.uploadedChunks,
        duration: this.duration
      });
      
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