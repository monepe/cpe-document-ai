
document.addEventListener('DOMContentLoaded', () => {

    const $ = (id) => document.getElementById(id);

    // ==========================================
    // เรียก API จาก Backend
    // ==========================================

    async function getJson(url, options = {}) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            ...options
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(
                data.error || 'เกิดข้อผิดพลาดในการโหลดข้อมูล'
            );
        }

        return data;
    }

    // ==========================================
    // 1. MY WORKLOAD DASHBOARD
    // ==========================================

    async function loadDashboard() {

        const box = $('workloadSummary');

        if (!box) return;

        box.textContent = 'กำลังโหลดข้อมูลภาระงาน...';

        try {

            const data = await getJson(
                '/api/workload/drive-dashboard'
            );

            box.replaceChildren();

            const total = document.createElement('h3');

            total.textContent =
                `เอกสารใน Google Drive: ${data.total} ไฟล์`;

            box.appendChild(total);

            for (const item of data.categories || []) {
                const section = document.createElement('div');
                section.style.cssText = 'border-bottom:1px solid #e2e6eb;padding:9px 0;';

                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.setAttribute('aria-expanded', 'false');
                toggle.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;padding:8px 0;font:inherit;';
                const title = document.createElement('span');
                title.textContent = `📁 ${item.name}: ${item.count} ไฟล์`;
                const arrow = document.createElement('span');
                arrow.textContent = '⌄';
                toggle.append(title, arrow);

                const details = document.createElement('div');
                details.hidden = true;
                details.style.cssText = 'padding:8px 0 8px 22px;';
                let loaded = false;
                let nextPageToken = null;

                async function fetchFiles(append = false) {
                    if (!append) details.textContent = 'กำลังโหลดรายชื่อไฟล์จาก Google Drive...';
                    try {
                        const params = new URLSearchParams({category: item.name});
                        if (append && nextPageToken) params.set('pageToken', nextPageToken);
                        const result = await getJson(`/api/workload/drive-category-files?${params}`);
                        if (!append) details.replaceChildren();
                        if (!append && !result.files?.length) {
                            details.textContent = 'ไม่มีไฟล์ในหมวดหมู่นี้';
                        }
                        for (const file of result.files || []) {
                            const line = document.createElement('div');
                            line.style.cssText = 'padding:7px 0;overflow-wrap:anywhere;';
                            if (file.url && /^https:\/\//i.test(file.url)) {
                                const link = document.createElement('a');
                                link.href = file.url;
                                link.target = '_blank';
                                link.rel = 'noopener noreferrer';
                                link.textContent = `📄 ${file.name} ↗`;
                                link.style.color = '#aa0a1d';
                                line.appendChild(link);
                            } else {
                                line.textContent = `📄 ${file.name} (ไม่มีลิงก์เปิดไฟล์)`;
                            }
                            details.appendChild(line);
                        }
                        nextPageToken = result.nextPageToken || null;
                        loaded = true;
                        details.querySelector('.drive-more-files')?.remove();
                        if (nextPageToken) {
                            const more = document.createElement('button');
                            more.type = 'button';
                            more.className = 'drive-more-files';
                            more.textContent = 'โหลดไฟล์เพิ่มเติม';
                            more.style.cssText = 'padding:7px 12px;margin-top:8px;cursor:pointer;';
                            more.addEventListener('click', async () => {
                                more.disabled = true;
                                await fetchFiles(true);
                                more.disabled = false;
                            });
                            details.appendChild(more);
                        }
                    } catch (error) {
                        const message = document.createElement('p');
                        message.textContent = `โหลดไฟล์ไม่สำเร็จ: ${error.message}`;
                        details.appendChild(message);
                    }
                }

                toggle.addEventListener('click', () => {
                    details.hidden = !details.hidden;
                    toggle.setAttribute('aria-expanded', String(!details.hidden));
                    arrow.textContent = details.hidden ? '⌄' : '⌃';
                    if (!details.hidden && !loaded) fetchFiles();
                });
                section.append(toggle, details);
                box.appendChild(section);
            }

        } catch (error) {

            box.textContent = error.message;
        }
    }

    // ==========================================
    // 2. ASK MY WORKLOAD
    // ==========================================

    async function askWorkload() {

        const input = $('workloadQuestion');
        const answer = $('workloadAnswer');
        const sources = $('workloadSources');
        const button = $('askWorkloadBtn');

        if (!input || !answer || !sources) return;

        const question = input.value.trim();

        if (!question) {
            answer.textContent = 'กรุณาพิมพ์คำถามก่อน';
            return;
        }

        answer.textContent = 'AI กำลังค้นหาข้อมูลจากเอกสาร...';
        sources.replaceChildren();

        if (button) button.disabled = true;

        try {

            const data = await getJson(
                '/api/workload/ask',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ question })
                }
            );

            answer.textContent =
                data.answer || 'ไม่พบคำตอบ';

            // แสดงเอกสารที่ AI ใช้อ้างอิง
            for (const item of data.sources || []) {

                const row = document.createElement('p');

                if (item.url) {

                    const link = document.createElement('a');

                    link.href = item.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';

                    link.textContent =
                        `[${item.ref}] ${item.name}`;

                    row.appendChild(link);

                } else {

                    row.textContent =
                        `[${item.ref}] ${item.name}`;
                }

                sources.appendChild(row);
            }

        } catch (error) {

            answer.textContent =
                `เกิดข้อผิดพลาด: ${error.message}`;

        } finally {

            if (button) button.disabled = false;
        }
    }

    // ==========================================
    // 3. EVIDENCE PORTFOLIO
    // ==========================================

    async function loadDocuments() {

        const box = $('workloadDocuments');
        const button = $('loadWorkloadDocumentsBtn');

        if (!box) return;

        box.textContent = 'กำลังโหลดรายการเอกสาร...';

        if (button) button.disabled = true;

        try {

            const data = await getJson(
                '/api/workload/documents'
            );

            box.replaceChildren();

            if (!data.documents || !data.documents.length) {

                box.textContent = 'ยังไม่มีเอกสารในระบบ';
                return;
            }

            for (const item of data.documents) {

                const row = document.createElement('p');

                if (item.url) {

                    const link = document.createElement('a');

                    link.href = item.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';

                    link.textContent = item.name;

                    row.appendChild(link);

                } else {

                    row.textContent = item.name;
                }

                const category = document.createElement('span');

                category.textContent =
                    ` — ${item.category || 'ไม่ระบุหมวดหมู่'}`;

                row.appendChild(category);

                box.appendChild(row);
            }

        } catch (error) {

            box.textContent =
                `เกิดข้อผิดพลาด: ${error.message}`;

        } finally {

            if (button) button.disabled = false;
        }
    }

    // ==========================================
    // 4. เชื่อมปุ่มกับฟังก์ชัน
    // ==========================================

    $('refreshWorkloadBtn')?.addEventListener(
        'click',
        loadDashboard
    );

    $('askWorkloadBtn')?.addEventListener(
        'click',
        askWorkload
    );

    $('loadWorkloadDocumentsBtn')?.addEventListener(
        'click',
        loadDocuments
    );

    // กด Enter เพื่อถาม AI
    // Shift + Enter เพื่อขึ้นบรรทัดใหม่
    $('workloadQuestion')?.addEventListener(
        'keydown',
        (event) => {

            if (event.key === 'Enter' && !event.shiftKey) {

                event.preventDefault();
                askWorkload();
            }
        }
    );

    // โหลด Dashboard ทันทีเมื่อเปิดหน้าเว็บ
    loadDashboard();

});
