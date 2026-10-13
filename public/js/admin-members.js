
/* =====================================================
   CPE DOCUMENT AI - ADMIN MEMBER MANAGEMENT
   ===================================================== */

(() => {
    'use strict';

    // =================================================
    // ELEMENTS
    // =================================================

    const adminBtn =
        document.getElementById('adminMembersBtn');

    const popup =
        document.getElementById('adminMembersPopup');

    const closeBtn =
        document.getElementById('adminCloseBtn');

    const messageBox =
        document.getElementById('adminMessage');

    const newMemberRows =
        document.getElementById('newMemberRows');

    const addRowBtn =
        document.getElementById('addMemberRowBtn');

    const saveMembersBtn =
        document.getElementById('saveMembersBtn');

    const membersTable =
        document.getElementById('adminMembersTable');

    if (
        !adminBtn ||
        !popup ||
        !closeBtn ||
        !messageBox ||
        !newMemberRows ||
        !addRowBtn ||
        !saveMembersBtn ||
        !membersTable
    ) {
        console.error(
            'Admin: ไม่พบ HTML Elements ที่จำเป็น'
        );
        return;
    }

    let currentUserId = null;
    let isAdmin = false;
    let isBusy = false;

    // =================================================
    // HELPERS
    // =================================================

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
    }

    function showMessage(text, type = 'info') {
        messageBox.textContent = text;

        messageBox.style.color =
            type === 'error'
                ? '#b42318'
                : type === 'success'
                    ? '#15803d'
                    : '#344054';
    }

    function clearMessage() {
        messageBox.textContent = '';
    }

    function normalizeEmail(email) {
        return String(email || '')
            .trim()
            .toLowerCase();
    }

    function validEmail(email) {
        return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/
            .test(email);
    }

    async function apiRequest(url, options = {}) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });

        const contentType =
            response.headers.get('content-type') || '';

        if (!contentType.includes('application/json')) {
            if (response.redirected) {
                throw new Error(
                    'กรุณาเข้าสู่ระบบใหม่อีกครั้ง'
                );
            }

            throw new Error(
                'Server ไม่ได้ส่งข้อมูล JSON กลับมา'
            );
        }

        const data = await response.json();

        if (!response.ok || data.success === false) {
            throw new Error(
                data.error ||
                `เกิดข้อผิดพลาด (${response.status})`
            );
        }

        return data;
    }

    function setBusy(value) {
        isBusy = value;

        saveMembersBtn.disabled = value;
        addRowBtn.disabled = value;

        membersTable
            .querySelectorAll('button')
            .forEach(button => {
                button.disabled = value;
            });
    }

    // =================================================
    // CHECK ADMIN ROLE
    // =================================================

    async function checkAdminRole() {
        try {
            const data = await apiRequest('/api/me', {
                method: 'GET'
            });

            const user = data.user || {};

            currentUserId = Number(user.id);

            isAdmin = user.role === 'admin';

            adminBtn.hidden = !isAdmin;

        } catch (error) {
            console.error(
                'ตรวจสอบสิทธิ์ Admin ไม่สำเร็จ:',
                error
            );

            isAdmin = false;
            adminBtn.hidden = true;
        }
    }

    // =================================================
    // OPEN / CLOSE POPUP
    // =================================================

    async function openPopup() {
        if (!isAdmin) return;

        clearMessage();

        popup.classList.add('show');

        if (!newMemberRows.children.length) {
            addMemberRow();
        }

        await loadMembers();
    }

    function closePopup() {
        if (isBusy) return;

        popup.classList.remove('show');
        clearMessage();
    }

    adminBtn.addEventListener('click', openPopup);

    closeBtn.addEventListener('click', closePopup);

    popup.addEventListener('click', event => {
        if (event.target === popup) {
            closePopup();
        }
    });

    document.addEventListener('keydown', event => {
        if (
            event.key === 'Escape' &&
            popup.classList.contains('show')
        ) {
            closePopup();
        }
    });

    // =================================================
    // ADD MEMBER INPUT ROW
    // =================================================

    function addMemberRow(email = '', role = 'user') {
        const row = document.createElement('div');

        row.className = 'admin-member-row';

        row.innerHTML = `
            <input
                type="email"
                class="admin-new-email"
                placeholder="example@gmail.com"
                value="${escapeHtml(email)}"
                autocomplete="off"
            >

            <select class="admin-new-role">
                <option value="user"
                    ${role === 'user' ? 'selected' : ''}>
                    User
                </option>

                <option value="admin"
                    ${role === 'admin' ? 'selected' : ''}>
                    Admin
                </option>
            </select>

            <button
                type="button"
                class="admin-secondary-btn admin-remove-row"
                title="ลบช่องนี้"
            >
                ×
            </button>
        `;

        row.querySelector('.admin-remove-row')
            .addEventListener('click', () => {
                row.remove();

                if (!newMemberRows.children.length) {
                    addMemberRow();
                }
            });

        newMemberRows.appendChild(row);
    }

    addRowBtn.addEventListener('click', () => {
        if (isBusy) return;

        addMemberRow();
    });

    // =================================================
    // BULK ADD MEMBERS
    // =================================================

    async function saveNewMembers() {
        if (isBusy) return;

        clearMessage();

        const rows = [
            ...newMemberRows.querySelectorAll(
                '.admin-member-row'
            )
        ];

        const members = [];
        const seenEmails = new Set();

        for (const row of rows) {
            const email = normalizeEmail(
                row.querySelector('.admin-new-email').value
            );

            const role =
                row.querySelector('.admin-new-role').value;

            if (!email) continue;

            if (!validEmail(email)) {
                showMessage(
                    `รูปแบบอีเมลไม่ถูกต้อง: ${email}`,
                    'error'
                );
                return;
            }

            if (seenEmails.has(email)) {
                showMessage(
                    `มีอีเมลซ้ำในรายการ: ${email}`,
                    'error'
                );
                return;
            }

            seenEmails.add(email);

            members.push({
                email,
                role
            });
        }

        if (!members.length) {
            showMessage(
                'กรุณากรอกอีเมลอย่างน้อย 1 คน',
                'error'
            );
            return;
        }

        if (members.length > 200) {
            showMessage(
                'เพิ่มสมาชิกได้ครั้งละไม่เกิน 200 คน',
                'error'
            );
            return;
        }

        setBusy(true);

        try {
            const data = await apiRequest(
                '/api/admin/members/bulk',
                {
                    method: 'POST',
                    body: JSON.stringify({ members })
                }
            );

            const added = data.added || [];
            const existing = data.existing || [];
            const invalid = data.invalid || [];
            const failed = data.failed || [];

            showMessage(
                `เพิ่มสมาชิกสำเร็จ ${added.length} คน\n` +
                `อีเมลที่มีอยู่แล้ว ${existing.length} คน\n` +
                `ข้อมูลไม่ถูกต้อง ${invalid.length} คน\n` +
                `เพิ่มไม่สำเร็จ ${failed.length} คน`,
                failed.length || invalid.length
                    ? 'error'
                    : 'success'
            );

            // ล้างรายการเฉพาะเมื่อเพิ่มครบทุกคน
            if (
                added.length === members.length &&
                !existing.length &&
                !invalid.length &&
                !failed.length
            ) {
                newMemberRows.innerHTML = '';
                addMemberRow();
            }

            await loadMembers();

        } catch (error) {
            showMessage(
                error.message,
                'error'
            );
        } finally {
            setBusy(false);
        }
    }

    saveMembersBtn.addEventListener(
        'click',
        saveNewMembers
    );

    // =================================================
    // LOAD MEMBERS
    // =================================================

    async function loadMembers() {
        membersTable.innerHTML = `
            <tr>
                <td colspan="3">
                    กำลังโหลดสมาชิก...
                </td>
            </tr>
        `;

        try {
            const data = await apiRequest(
                '/api/admin/members',
                {
                    method: 'GET'
                }
            );

            renderMembers(data.members || []);

        } catch (error) {
            membersTable.innerHTML = `
                <tr>
                    <td colspan="3">
                        ไม่สามารถโหลดรายชื่อสมาชิกได้
                    </td>
                </tr>
            `;

            showMessage(
                error.message,
                'error'
            );
        }
    }

    // =================================================
    // RENDER MEMBER TABLE
    // =================================================

    function renderMembers(members) {
        membersTable.innerHTML = '';

        if (!members.length) {
            membersTable.innerHTML = `
                <tr>
                    <td colspan="3">
                        ยังไม่มีสมาชิกในระบบ
                    </td>
                </tr>
            `;
            return;
        }

        members.forEach(member => {
            const id = Number(member.id);

            const isSelf = id === currentUserId;

            const row = document.createElement('tr');

            row.innerHTML = `
                <td>
                    <input
                        type="email"
                        class="admin-edit-email"
                        value="${escapeHtml(member.email)}"
                    >
                </td>

                <td>
                    <select class="admin-edit-role">
                        <option value="user"
                            ${member.role === 'user'
                                ? 'selected'
                                : ''}>
                            User
                        </option>

                        <option value="admin"
                            ${member.role === 'admin'
                                ? 'selected'
                                : ''}>
                            Admin
                        </option>
                    </select>
                </td>

                <td>
                    <button
                        type="button"
                        class="admin-save-edit"
                    >
                        บันทึก
                    </button>

                    <button
                        type="button"
                        class="admin-delete-member"
                        ${isSelf ? 'disabled' : ''}
                    >
                        ลบ
                    </button>
                </td>
            `;

            const emailInput =
                row.querySelector('.admin-edit-email');

            const roleSelect =
                row.querySelector('.admin-edit-role');

            const saveBtn =
                row.querySelector('.admin-save-edit');

            const deleteBtn =
                row.querySelector('.admin-delete-member');

            // ป้องกันเปลี่ยน Role ของตนเอง
            if (isSelf) {
                roleSelect.disabled = true;
            }

            saveBtn.addEventListener('click', () => {
                updateMember(
                    id,
                    emailInput.value,
                    roleSelect.value
                );
            });

            deleteBtn.addEventListener('click', () => {
                deleteMember(
                    id,
                    member.email
                );
            });

            membersTable.appendChild(row);
        });
    }

    // =================================================
    // UPDATE MEMBER
    // =================================================

    async function updateMember(id, emailValue, role) {
        if (isBusy) return;

        const email = normalizeEmail(emailValue);

        if (!validEmail(email)) {
            showMessage(
                'กรุณากรอกอีเมลให้ถูกต้อง',
                'error'
            );
            return;
        }

        if (!['user', 'admin'].includes(role)) {
            showMessage(
                'Role ไม่ถูกต้อง',
                'error'
            );
            return;
        }

        const confirmed = confirm(
            `ต้องการบันทึกข้อมูลสมาชิกนี้หรือไม่?\n\n` +
            `อีเมล: ${email}\n` +
            `Role: ${role}`
        );

        if (!confirmed) return;

        setBusy(true);

        try {
            await apiRequest(
                `/api/admin/members/${id}`,
                {
                    method: 'PATCH',
                    body: JSON.stringify({
                        email,
                        role
                    })
                }
            );

            showMessage(
                'แก้ไขข้อมูลสมาชิกเรียบร้อยแล้ว',
                'success'
            );

            await loadMembers();

        } catch (error) {
            showMessage(
                error.message,
                'error'
            );
        } finally {
            setBusy(false);
        }
    }

    // =================================================
    // DELETE MEMBER
    // =================================================

    async function deleteMember(id, email) {
        if (isBusy) return;

        if (id === currentUserId) {
            showMessage(
                'ไม่สามารถลบบัญชีของตนเองได้',
                'error'
            );
            return;
        }

        const confirmed = confirm(
            `คุณต้องการลบสมาชิกนี้ใช่หรือไม่?\n\n` +
            `${email}\n\n` +
            `การดำเนินการนี้ไม่สามารถย้อนกลับได้`
        );

        if (!confirmed) return;

        setBusy(true);

        try {
            await apiRequest(
                `/api/admin/members/${id}`,
                {
                    method: 'DELETE'
                }
            );

            showMessage(
                `ลบสมาชิก ${email} เรียบร้อยแล้ว`,
                'success'
            );

            await loadMembers();

        } catch (error) {
            showMessage(
                error.message,
                'error'
            );
        } finally {
            setBusy(false);
        }
    }

    // =================================================
    // INITIALIZE
    // =================================================

    addMemberRow();

    checkAdminRole();

})();
