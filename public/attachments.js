(() => {
  const panel = document.querySelector('#editorAttachmentsPanel');
  const notice = document.querySelector('#attachmentNotice');
  const save = document.querySelector('#saveNoticeBtn');
  const drop = document.querySelector('#attachmentDropZone');
  const files = document.querySelector('#attachmentFiles');
  const message = document.querySelector('#attachmentMessage');
  const list = document.querySelector('#attachmentList');
  let context = null;
  let serial = 0;
  let uploading = false;
  const current = token => token === serial && context;
  async function refresh(token = serial) {
    if (!current(token)) return;
    const url = context.url;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '附件读取失败');
      if (!current(token)) return;
      list.replaceChildren();
      if (!payload.attachments.length) list.textContent = '暂无附件';
      for (const item of payload.attachments) {
        const row = document.createElement('div'); row.className = 'attachment-item';
        const link = document.createElement('a');
        link.href = `${url}/${encodeURIComponent(item.id)}`; link.textContent = item.filename; link.download = item.filename;
        const detail = document.createElement('small'); detail.textContent = `${(item.size / 1024).toFixed(1)} KiB · ${new Date(item.uploadedAt).toLocaleString()}`;
        row.append(link, detail); list.append(row);
      }
    } catch (error) { if (current(token)) { list.replaceChildren(); message.textContent = error.message; } }
  }
  async function upload(selected) {
    if (!context || uploading || !selected.length) return;
    const token = serial, target = context;
    uploading = true; drop.setAttribute('aria-busy', 'true'); files.disabled = true;
    let count = 0;
    try {
      for (const file of selected) {
        if (!current(token)) break;
        if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} 超过 50 MiB；已保存 ${count} 个附件`);
        message.textContent = `正在上传 ${file.name}…`;
        const payload = await target.upload(file);
        if (!payload) break;
        count++;
      }
      if (current(token)) message.textContent = `已保存 ${count} 个附件`;
    } catch (error) { if (current(token)) message.textContent = `${error.message}（此前已保存 ${count} 个）`; }
    finally {
      if (current(token)) {
        uploading = false; files.disabled = false; files.value = ''; drop.removeAttribute('aria-busy');
        await refresh(token);
      }
    }
  }
  save.addEventListener('click', async () => {
    if (!context) return;
    const token = serial, target = context;
    save.disabled = true;
    try {
      const ok = await target.saveNotice(notice.value);
      if (current(token) && ok) message.textContent = '通知文本已保存';
    } catch (error) { if (current(token)) message.textContent = error.message; }
    finally { if (current(token)) save.disabled = false; }
  });
  drop.addEventListener('click', event => { if (event.target !== files && !uploading) files.click(); });
  drop.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!uploading) files.click(); } });
  files.addEventListener('change', () => upload([...files.files]));
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('drag-over'); upload([...event.dataTransfer.files]); });
  // Prevent dropping outside the file zone from navigating away and losing a draft.
  panel.addEventListener('dragover', event => event.preventDefault());
  panel.addEventListener('drop', event => event.preventDefault());
  document.querySelector('#refreshAttachmentsBtn').addEventListener('click', () => { message.textContent = ''; refresh(); });
  window.BoboAttachments = {
    reset() { serial++; context = null; uploading = false; files.disabled = false; save.disabled = false; drop.removeAttribute('aria-busy'); },
    open(value) {
      serial++; context = value; notice.value = value.text; message.textContent = ''; files.value = ''; list.textContent = '正在读取附件…'; refresh();
    }
  };
})();
