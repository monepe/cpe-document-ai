
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

            const note = document.createElement('p');
            note.textContent = data.note || 'นับไฟล์จาก Google Drive ที่บัญชีปัจจุบันเข้าถึงได้';
            box.appendChild(note);

            for (const item of data.categories || []) {

                const row = document.createElement('p');

                row.textContent =
                    `${item.name}: ${item.count} ไฟล์`;

                box.appendChild(row);
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
