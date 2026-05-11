class VideoRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.isRecording = false;
    this.startTime = 0;
    this.duration = 0;
    this.failedChunks = [];      // 上传失败的片段缓存
    this.uploadedChunks = 0;     // 成功上传的片段数
    this.nextChunkIndex = 0;     // 下一个片段的序号（同步分配，避免并发冲突）
    this.taskId = '';
    this.isFinalizing = false;
    this.isUploading = false;    // 是否正在上传（队列锁）
    this.uploadQueue = [];       // 上传队列

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
      document.getElementById('back-btn').addEventListener('click', () => this.goBack());
      this.updateStatus('摄像头已就绪');
    } catch (err) {
      this.updateStatus('摄像头启动失败: ' + err.message);
      this.notifyMiniProgram('error', { message: err.message });
    }
  }

  goBack() {
    if (this.isRecording) {
      if (!confirm('正在录制中，返回将放弃当前录制，确定吗？')) return;
      this.stop();
      setTimeout(() => {
        this.notifyMiniProgram('error', { message: '用户主动返回，录制已取消' });
      }, 500);
    } else {
      this.notifyMiniProgram('error', { message: '用户主动返回' });
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

    this.failedChunks = [];
    this.uploadedChunks = 0;
    this.nextChunkIndex = 0;
    this.isRecording = true;
    this.isFinalizing = false;
    this.isUploading = false;
    this.uploadQueue = [];
    this.startTime = Date.now();

    // ========== 关键修改：timeslice 从 3000ms 改为 5000ms，减少请求频率 ==========
    this.mediaRecorder.start(5000);

    // ondataavailable 中同步分配 index，避免并发冲突
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        const index = this.nextChunkIndex++;
        this.uploadQueue.push({ index, blob: e.data, timestamp: Date.now() });
        this.processUploadQueue();
      }
    };

    this.mediaRecorder.onstop = () => {
      this.finalize().catch(err => {
        console.error('finalize 异常:', err);
        this.updateStatus('处理失败: ' + err.message);
        this.notifyMiniProgram('error', { message: err.message });
      });
    };

    this.mediaRecorder.onerror = (err) => {
      console.error('MediaRecorder 错误:', err);
      this.updateStatus('录制器错误: ' + (err.message || '未知'));
      this.notifyMiniProgram('error', { message: 'MediaRecorder错误: ' + (err.message || '') });
    };

    document.getElementById('toggleBtn').classList.add('recording');
    document.getElementById('toggleBtn').textContent = '停止';
    this.updateStatus('录制中...');
    this.startTimer();

    // 到达最大时长自动停止
    this.autoStopTimer = setTimeout(() => {
      if (this.isRecording) {
        this.updateStatus('已达到最大时长，自动停止');
        this.stop();
      }
    }, this.maxDuration * 1000);

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

  // ========== 上传队列处理器（顺序上传，避免并发冲突） ==========
  async processUploadQueue() {
    if (this.isUploading || this.uploadQueue.length === 0) return;
    this.isUploading = true;

    while (this.uploadQueue.length > 0) {
      const item = this.uploadQueue.shift();
      await this.uploadChunk(item.index, item.blob, item.timestamp);
    }

    this.isUploading = false;
    // 如果队列在此过程中又有新数据，继续处理
    if (this.uploadQueue.length > 0) {
      this.processUploadQueue();
    }
  }

  async uploadChunk(index, blob, timestamp) {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const base64 = this.arrayBufferToBase64(arrayBuffer);

      const body = {
        action: 'upload',
        taskId: this.taskId,
        index: index,
        timestamp: timestamp,
        fileData: base64,
        fileName: `chunk_${index}.webm`,
        userId: this.userId,
        scriptId: this.scriptId
      };

      const result = await this.xhrPost(this.uploadUrl, body);

      if (result.success) {
        this.uploadedChunks++;
        this.updateStatus(`已上传 ${this.uploadedChunks} 段`);
      } else {
        throw new Error(result.message || '服务器返回上传失败');
      }
    } catch (err) {
      console.error(`第 ${index} 段上传错误:`, err);
      // 缓存失败片段供 finalize 重试
      this.failedChunks.push({
        index: index,
        blob: blob,
        timestamp: timestamp
      });
      this.updateStatus(`第 ${index + 1} 段上传失败: ${err.message}`);
    }
  }

  // ========== 安全的 ArrayBuffer 转 Base64（分块避免栈溢出） ==========
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunkSize = 0x8000; // 32768，安全的单次处理长度
    let binary = '';
    for (let i = 0; i < len; i += chunkSize) {
      const slice = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
  }

  xhrPost(url, data) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 30000;

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            resolve(result);
          } catch (err) {
            reject(new Error('解析响应失败(' + xhr.status + '): ' + xhr.responseText.substring(0, 200)));
          }
        } else {
          reject(new Error('HTTP ' + xhr.status + ': ' + (xhr.statusText || '未知错误') + ' | 响应:' + xhr.responseText.substring(0, 200)));
        }
      };

      xhr.onerror = () => reject(new Error('网络请求失败，请检查 CORS、HTTPS 或网络连接'));
      xhr.ontimeout = () => reject(new Error('请求超时(30s)'));

      try {
        xhr.send(JSON.stringify(data));
      } catch (err) {
        reject(new Error('发送请求失败: ' + err.message));
      }
    });
  }

  stop() {
    if (!this.isRecording || this.isFinalizing) return;
    this.isRecording = false;
    this.isFinalizing = true;

    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    document.getElementById('toggleBtn').disabled = true;
    document.getElementById('toggleBtn').classList.remove('recording');
    document.getElementById('toggleBtn').textContent = '处理中';
    this.updateStatus('正在停止录制...');
    this.stopTimer();

    // 先停止 MediaRecorder，让 onstop 触发 finalize
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  async finalize() {
    this.duration = Date.now() - this.startTime;
    this.updateStatus('正在处理，请稍候...');

    // 等待队列中的上传任务全部完成
    if (this.isUploading) {
      this.updateStatus('等待剩余片段上传...');
      while (this.isUploading) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // 停止摄像头预览
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    // 重试失败的片段
    if (this.failedChunks.length > 0) {
      this.updateStatus(`正在重试 ${this.failedChunks.length} 个失败片段...`);
      const retryChunks = [...this.failedChunks];
      this.failedChunks = []; // 清空，重试失败的会再压入

      for (const chunk of retryChunks) {
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

          const result = await this.xhrPost(this.uploadUrl, body);
          if (!result.success) {
            throw new Error(result.message || '重试上传失败');
          }
          this.uploadedChunks++;
        } catch (err) {
          console.error(`重试片段 ${chunk.index} 失败:`, err);
          this.failedChunks.push(chunk);
        }
      }
    }

    if (this.failedChunks.length > 0) {
      const msg = `${this.failedChunks.length} 个片段最终上传失败，无法合并`;
      this.updateStatus(msg);
      this.notifyMiniProgram('error', { message: msg });
      return;
    }

    // 触发合并
    try {
      this.updateStatus('正在合并视频...');
      const mergeResult = await this.xhrPost(this.uploadUrl, {
        action: 'merge',
        taskId: this.taskId,
        totalChunks: this.nextChunkIndex, // 使用 nextChunkIndex（总段数）替代 uploadedChunks
        duration: this.duration
      });

      if (!mergeResult.success) {
        throw new Error(mergeResult.message || '合并失败');
      }

      this.updateStatus('视频处理完成');
      document.getElementById('toggleBtn').textContent = '完成';

      // 冗余保险：直接更新数据库状态
      try {
        await this.xhrPost(this.uploadUrl, {
          action: 'updateRecord',
          taskId: this.taskId,
          status: 'uploaded',
          fileUrl: mergeResult.fileID,
          segments: mergeResult.segments || [],
          duration: this.duration
        });
      } catch (e) {
        console.error('updateRecord 失败:', e);
      }

      this.notifyMiniProgram('complete', {
        taskId: this.taskId,
        duration: this.duration,
        fileUrl: mergeResult.fileID || '',
        segments: mergeResult.segments || []
      });
    } catch (err) {
      console.error('合并失败:', err);
      this.updateStatus('合并失败: ' + err.message);
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
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  formatTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  updateStatus(msg) {
    console.log('[Status]', msg);
    document.getElementById('status').textContent = msg;
  }

  notifyMiniProgram(action, data) {
    if (window.wx && wx.miniProgram) {
      wx.miniProgram.postMessage({ data: { action, ...data, timestamp: Date.now() } });
    }
  }
}

const recorder = new VideoRecorder();
