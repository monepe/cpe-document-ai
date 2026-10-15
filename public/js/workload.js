
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
    // Export Dashboard to print-ready PDF with clickable Drive links
    // ==========================================
    async function exportDashboardPdf() {
        const button = $('exportDashboardPdfBtn');
        // Open immediately on user click to avoid popup blockers.
        const preview = window.open('', '_blank');
        if (!preview) {
            alert('กรุณาอนุญาต Pop-ups สำหรับเว็บไซต์นี้ เพื่อเปิดหน้าบันทึก PDF');
            return;
        }
        if (button) {
            button.disabled = true;
            button.textContent = 'กำลังรวบรวมไฟล์...';
        }

        const doc = preview.document;
        doc.title = 'รายงานสรุปภาระงาน - CPE Document AI';
        doc.documentElement.lang = 'th';
        doc.head.replaceChildren();
        const meta = doc.createElement('meta');
        meta.setAttribute('charset', 'utf-8');
        doc.head.appendChild(meta);
        const style = doc.createElement('style');
        style.textContent = `
            @page { size: A4; margin: 16mm 14mm; }
            body { font-family: "Sarabun", "Noto Sans Thai", Tahoma, Arial, sans-serif;
                   color:#16213a; font-size:12px; line-height:1.6; margin:24px; }
            h1 { color:#990b1a; font-size:22px; margin-bottom:3px; }
            h2 { color:#990b1a; font-size:16px; margin:22px 0 6px; }
            .sub { color:#53637b; }
            .summary { border:1px solid #dedede; padding:12px; margin:14px 0; }
            .file { padding:6px 0; border-bottom:1px solid #e5e7eb; overflow-wrap:anywhere; }
            a { color:#a30a1d; text-decoration:underline; }
            .tools { margin:12px 0 22px; }
            .tools button { background:#a30a1d; color:white; border:0; padding:11px 20px;
                            border-radius:8px; cursor:pointer; font:inherit; }
            .hint { color:#586276; font-size:11px; }
            section { break-inside:avoid-page; }
            @media print {
                body { margin:0; }
                .tools { display:none; }
                a { color:#a30a1d; }
                .file { break-inside:avoid; }
            }`;
        doc.head.appendChild(style);
        doc.body.replaceChildren();
        const status = doc.createElement('p');
        status.textContent = 'กำลังดึงรายชื่อไฟล์ทั้งหมดจาก Google Drive กรุณารอสักครู่...';
        doc.body.appendChild(status);

        const el = (tag, text, parent, cls) => {
            const node = doc.createElement(tag);
            if (text !== undefined) node.textContent = String(text);
            if (cls) node.className = cls;
            parent.appendChild(node);
            return node;
        };

        try {
            const dashboard = await getJson('/api/workload/drive-dashboard');
            const groups = [];
            for (const category of dashboard.categories || []) {
                const files = [];
                let token = null;
                let pages = 0;
                do {
                    const params = new URLSearchParams({ category: category.name });
                    if (token) params.set('pageToken', token);
                    const data = await getJson(`/api/workload/drive-category-files?${params}`);
                    files.push(...(data.files || []));
                    token = data.nextPageToken || null;
                    pages++;
                    if (pages > 100) throw new Error('รายการไฟล์มากเกินขอบเขตที่กำหนด กรุณาติดต่อผู้ดูแลระบบ');
                } while (token);
                groups.push({ name: category.name, files });
            }

            doc.body.replaceChildren();
            el('h1', 'รายงานสรุปภาระงาน', doc.body);
            el('p', 'CPE Document AI — รายการหลักฐานจาก Google Drive', doc.body, 'sub');
            el('p', 'วันที่จัดทำรายงาน: ' + new Date().toLocaleString('th-TH'), doc.body, 'sub');
            const count = groups.reduce((sum, group) => sum + group.files.length, 0);
            el('div', `เอกสารทั้งหมด ${count} ไฟล์ | ${groups.length} หมวดหมู่`, doc.body, 'summary');

            const tools = el('div', undefined, doc.body, 'tools');
            const print = el('button', 'บันทึกเป็น PDF / พิมพ์รายงาน', tools);
            print.type = 'button';
            print.addEventListener('click', () => preview.print());
            el('p', 'เลือกปลายทาง “Save as PDF / บันทึกเป็น PDF” ในหน้าต่างพิมพ์ของเบราว์เซอร์', tools, 'hint');

            for (const group of groups) {
                const section = el('section', undefined, doc.body);
                el('h2', `${group.name} (${group.files.length} ไฟล์)`, section);
                if (!group.files.length) {
                    el('p', 'ไม่มีไฟล์ในหมวดหมู่นี้', section, 'sub');
                    continue;
                }
                group.files.forEach((file, i) => {
                    const line = el('div', undefined, section, 'file');
                    el('span', `${i + 1}. `, line);
                    if (file.url && /^https:\/\/(?:drive\.google\.com|docs\.google\.com)\//i.test(file.url)) {
                        const link = el('a', file.name || 'ไม่มีชื่อไฟล์', line);
                        link.href = file.url;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                    } else {
                        el('span', (file.name || 'ไม่มีชื่อไฟล์') + ' (ไม่มีลิงก์)', line);
                    }
                });
            }
            el('p', 'กดชื่อไฟล์ใน PDF เพื่อเปิดหลักฐานบน Google Drive (ต้องมีสิทธิ์เข้าถึงไฟล์)', doc.body, 'hint');
            if (count !== Number(dashboard.total)) {
                el('p', 'หมายเหตุ: จำนวนไฟล์ที่อ่านได้อาจเปลี่ยนระหว่างจัดทำรายงาน', doc.body, 'hint');
            }
            preview.focus();
        } catch (error) {
            status.textContent = `ไม่สามารถจัดทำรายงานได้: ${error.message}`;
            status.style.color = '#a30a1d';
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = 'บันทึกรายงาน PDF';
            }
        }
    }

    function addDashboardPdfButton() {
        const summary = $('workloadSummary');
        if (!summary || $('exportDashboardPdfBtn')) return;
        const button = document.createElement('button');
        button.id = 'exportDashboardPdfBtn';
        button.type = 'button';
        button.textContent = 'บันทึกรายงาน PDF';
        button.style.cssText = 'background:#a30a1d;color:#fff;border:0;border-radius:9px;padding:11px 18px;cursor:pointer;font:inherit;font-weight:600;margin:0 0 12px;';
        button.addEventListener('click', exportDashboardPdf);
        summary.parentElement.insertBefore(button, summary);
    }

    addDashboardPdfButton();

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
