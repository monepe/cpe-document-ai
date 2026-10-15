
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
        if (button) { button.disabled = true; button.textContent = 'กำลังรวบรวมไฟล์...'; }
        let report = null;
        let printStyle = null;
        try {
            const dashboard = await getJson('/api/workload/drive-dashboard');
            const groups = [];
            for (const category of dashboard.categories || []) {
                const files = [];
                let pageToken = null;
                let pageCount = 0;
                do {
                    const params = new URLSearchParams({category: category.name});
                    if (pageToken) params.set('pageToken', pageToken);
                    const data = await getJson(`/api/workload/drive-category-files?${params}`);
                    files.push(...(data.files || []));
                    pageToken = data.nextPageToken || null;
                    if (++pageCount > 100) throw new Error('มีรายการไฟล์มากเกินกว่าที่รองรับ');
                } while (pageToken);
                groups.push({name: category.name, files});
            }

            // The report is rendered only during printing, on this same Dashboard tab.
            document.getElementById('cpePrintReport')?.remove();
            document.getElementById('cpePrintReportStyle')?.remove();
            printStyle = document.createElement('style');
            printStyle.id = 'cpePrintReportStyle';
            printStyle.textContent = `
                #cpePrintReport { display:none; }
                @page { size:A4; margin:14mm; }
                @media print {
                    body > *:not(#cpePrintReport) { display:none !important; }
                    html,body { background:#fff !important; margin:0 !important; padding:0 !important; }
                    #cpePrintReport { display:block !important; position:static !important;
                        font-family:Tahoma, "Noto Sans Thai", Arial, sans-serif !important;
                        color:#17243a !important; font-size:11pt !important; line-height:1.6 !important; }
                    #cpePrintReport h1 { font-size:20pt !important; color:#990b1a !important; margin:0 0 4px !important; }
                    #cpePrintReport h2 { font-size:13pt !important; color:#990b1a !important; margin:14px 0 5px !important; }
                    #cpePrintReport .cpe-print-summary { border:1px solid #ddd; padding:10px; margin:12px 0; }
                    #cpePrintReport .cpe-print-file { border-bottom:1px solid #eee; padding:5px 0; overflow-wrap:anywhere; break-inside:avoid; }
                    #cpePrintReport a { color:#990b1a !important; text-decoration:underline !important; }
                    #cpePrintReport section { break-inside:auto; }
                    #cpePrintReport .cpe-print-muted { color:#586276 !important; font-size:9pt !important; }
                }
            `;
            document.head.appendChild(printStyle);
            report = document.createElement('article');
            report.id = 'cpePrintReport';
            const add = (parent, tag, content, cls) => {
                const node = document.createElement(tag);
                if (content !== undefined) node.textContent = String(content);
                if (cls) node.className = cls;
                parent.appendChild(node);
                return node;
            };
            add(report, 'h1', 'รายงานสรุปภาระงาน');
            add(report, 'p', 'CPE Document AI | มหาวิทยาลัยราชภัฏลำปาง', 'cpe-print-muted');
            add(report, 'p', 'วันที่จัดทำ: ' + new Date().toLocaleString('th-TH'), 'cpe-print-muted');
            const total = groups.reduce((n, g) => n + g.files.length, 0);
            add(report, 'div', `เอกสารใน Google Drive: ${total} ไฟล์`, 'cpe-print-summary');
            for (const group of groups) {
                const section = add(report, 'section');
                add(section, 'h2', `${group.name}: ${group.files.length} ไฟล์`);
                if (!group.files.length) add(section, 'p', 'ไม่มีไฟล์ในหมวดหมู่นี้', 'cpe-print-muted');
                group.files.forEach((file, i) => {
                    const row = add(section, 'div', undefined, 'cpe-print-file');
                    add(row, 'span', `${i + 1}. `);
                    if (file.url && /^https:\/\/(drive|docs)\.google\.com\//i.test(file.url)) {
                        const link = add(row, 'a', file.name || 'ไม่มีชื่อไฟล์');
                        link.href = file.url;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                    } else add(row, 'span', (file.name || 'ไม่มีชื่อไฟล์') + ' (ไม่มีลิงก์)');
                });
            }
            add(report, 'p', 'คลิกชื่อไฟล์ใน PDF เพื่อเปิดเอกสารบน Google Drive (ต้องมีสิทธิ์เข้าถึง)', 'cpe-print-muted');
            document.body.appendChild(report);
            const cleanup = () => {
                report?.remove();
                printStyle?.remove();
                window.removeEventListener('afterprint', cleanup);
            };
            window.addEventListener('afterprint', cleanup);
            // Print the current page; no window.open, navigation, or new tab.
            window.print();
        } catch (error) {
            report?.remove();
            printStyle?.remove();
            alert('ไม่สามารถสร้างรายงาน PDF: ' + error.message);
        } finally {
            if (button) { button.disabled = false; button.textContent = 'บันทึกรายงาน PDF'; }
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
