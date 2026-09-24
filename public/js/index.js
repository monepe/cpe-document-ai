const imageInput = document.getElementById('imageInput');
const dropArea = document.getElementById('dropArea');
const fileName = document.getElementById('fileName');
const uploadForm = document.getElementById('uploadForm');
const submitBtn = document.getElementById('submitBtn');

const loading = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');

const resultBox = document.getElementById('result');
const reasonBox = document.getElementById('reason');
const categoryList = document.getElementById('categoryList');
const uploadStatus = document.getElementById('uploadStatus');

// Popup ยืนยันหมวด
const confirmPopup = document.getElementById('confirmPopup');
const confirmCategoryName = document.getElementById('confirmCategoryName');
const confirmCancelButton = document.getElementById('confirmCancelButton');
const confirmOkButton = document.getElementById('confirmOkButton');

// Popup สำเร็จ
const successPopup = document.getElementById('successPopup');
const successPopupText = document.getElementById('successPopupText');
const successPopupButton = document.getElementById('successPopupButton');

let currentUploadToken = null;
let pendingCategory = null;
let isUploading = false;

const MAX_FILE_SIZE = 50 * 1024 * 1024; // จำกัดไฟล์ 20 MB


// ========================================
// เลือกไฟล์
// ========================================

dropArea.addEventListener('click', () => {
    imageInput.click();
});


imageInput.addEventListener('change', () => {

    if (!imageInput.files.length) return;

    const file = imageInput.files[0];

    if (!validateFileSize(file)) {
        imageInput.value = '';
        return;
    }

    showSelectedFile(file);

});


// ========================================
// Drag & Drop
// ========================================

['dragenter', 'dragover'].forEach(eventName => {

    dropArea.addEventListener(eventName, e => {

        e.preventDefault();

        dropArea.classList.add('dragging');

    });

});


['dragleave', 'drop'].forEach(eventName => {

    dropArea.addEventListener(eventName, e => {

        e.preventDefault();

        dropArea.classList.remove('dragging');

    });

});


dropArea.addEventListener('drop', e => {

    const files = e.dataTransfer.files;

    if (!files.length) return;

    const file = files[0];

    if (!validateFileSize(file)) return;

    const transfer = new DataTransfer();

    transfer.items.add(file);

    imageInput.files = transfer.files;

    showSelectedFile(file);

});


// ========================================
// ตรวจสอบขนาดไฟล์
// ========================================

function validateFileSize(file) {

    if (file.size > MAX_FILE_SIZE) {

        alert(
            'ไฟล์มีขนาดใหญ่เกินไป\nกรุณาเลือกไฟล์ขนาดไม่เกิน 20 MB'
        );

        return false;

    }

    return true;

}


// ========================================
// แสดงไฟล์ที่เลือก
// ========================================

function showSelectedFile(file) {

    fileName.textContent =
        `ไฟล์ที่เลือก: ${file.name}`;

    currentUploadToken = null;

    resultBox.style.display = 'none';

    categoryList.innerHTML = '';

    reasonBox.textContent = '';

    resetStatus();

}


// ========================================
// วิเคราะห์เอกสาร
// ========================================

uploadForm.addEventListener('submit', async e => {

    e.preventDefault();

    if (!imageInput.files.length) {

        alert('กรุณาเลือกไฟล์ก่อนวิเคราะห์');

        return;

    }

    const file = imageInput.files[0];

    if (!validateFileSize(file)) return;

    const formData = new FormData();

    formData.append('image', file);

    startLoading();

    try {

        const res = await fetch('/api/classify', {

            method: 'POST',

            body: formData

        });

        const data = await res.json();

        if (!res.ok || !data.success) {

            throw new Error(
                data.error ||
                'วิเคราะห์เอกสารไม่สำเร็จ'
            );

        }

        currentUploadToken = data.uploadToken;

        reasonBox.textContent =
            data.reason ||
            'AI วิเคราะห์คะแนนความเหมาะสมของแต่ละหมวดแล้ว';

        renderCategories(
            data.categories || [],
            data.recommendedCategory
        );

        resultBox.style.display = 'block';

        if (window.innerWidth <= 900) {

            resultBox.scrollIntoView({

                behavior: 'smooth',

                block: 'start'

            });

        }

    } catch (err) {

        console.error(err);

        alert(
            err.message ||
            'ไม่สามารถเชื่อมต่อ Server ได้'
        );

    } finally {

        stopLoading();

    }

});


// ========================================
// แสดงผลหมวดหมู่
// เปอร์เซ็นต์ -> หลอด -> ปุ่ม
// ========================================

function renderCategories(categories, recommendedCategory) {

    categoryList.innerHTML = '';

    const sorted = [...categories].sort(
        (a, b) =>
            Number(b.percentage || 0) -
            Number(a.percentage || 0)
    );

    if (!sorted.length) {

        categoryList.innerHTML =
            '<div class="reason-box">ไม่พบผลการจำแนกหมวดหมู่</div>';

        return;

    }

    const recommended =
        recommendedCategory ||
        sorted[0]?.name;

    sorted.forEach((item, index) => {

        const percent = Math.max(
            0,
            Math.min(
                100,
                Number(item.percentage) || 0
            )
        );

        const isRecommended =
            item.name === recommended;

        const card =
            document.createElement('div');

        card.className =
            `category-card${isRecommended ? ' recommended' : ''}`;

        card.innerHTML = `

            <div class="category-top">

                <div class="category-name-wrapper">

                    <span class="category-rank">
                        ${index + 1}
                    </span>

                    <span class="category-name">
                        ${escapeHtml(item.name)}
                    </span>

                    ${
                        isRecommended
                            ? '<span class="badge">AI แนะนำ</span>'
                            : ''
                    }

                </div>

            </div>


            <div class="category-progress-row">

                <div class="category-percent">
                    ${percent.toFixed(2)}%
                </div>

                <div class="progress-track">

                    <div
                        class="progress-fill"
                        style="width:${percent}%"
                    ></div>

                </div>

                <button
                    type="button"
                    class="btn-confirm-category"
                >
                    ✓ ยืนยันหมวดนี้
                </button>

            </div>


            <div class="category-description">

                ${
                    isRecommended
                        ? 'AI ประเมินว่าหมวดนี้มีความสอดคล้องกับเอกสารมากที่สุด'
                        : 'สามารถเลือกหมวดนี้ได้ หากตรวจสอบแล้วตรงกับเนื้อหาเอกสาร'
                }

            </div>

        `;

        const button =
            card.querySelector(
                '.btn-confirm-category'
            );

        button.addEventListener(
            'click',
            event => {

                event.stopPropagation();

                confirmCategory(item.name);

            }
        );

        categoryList.appendChild(card);

    });

}


// ========================================
// เปิด Popup ยืนยันหมวด
// ========================================

function confirmCategory(category) {

    if (!currentUploadToken) {

        alert(
            'ไม่พบข้อมูลไฟล์ กรุณาวิเคราะห์เอกสารใหม่'
        );

        return;

    }

    pendingCategory = category;

    confirmCategoryName.textContent =
        category;

    confirmPopup.classList.add('show');

}


// ปิด Popup ยืนยัน
function closeConfirmPopup() {

    confirmPopup.classList.remove('show');

    pendingCategory = null;

}


// กดยกเลิก
confirmCancelButton.addEventListener(
    'click',
    closeConfirmPopup
);


// กดยืนยัน
confirmOkButton.addEventListener(
    'click',
    () => {

        if (!pendingCategory) return;

        const category =
            pendingCategory;

        pendingCategory = null;

        confirmPopup.classList.remove('show');

        uploadToDrive(category);

    }
);


// คลิกพื้นหลังเพื่อปิด
confirmPopup.addEventListener(
    'click',
    e => {

        if (e.target === confirmPopup) {

            closeConfirmPopup();

        }

    }
);


// ========================================
// Upload Google Drive
// ========================================

async function uploadToDrive(category) {

    if (
        !currentUploadToken ||
        isUploading
    ) {
        return;
    }

    isUploading = true;

    setButtonsDisabled(true);

    showStatus(
        `กำลังจัดเก็บเอกสารเข้า Google Drive หมวด [${category}]...`,
        'loading'
    );

    try {

        const res =
            await fetch(
                '/api/upload-selected-category',
                {

                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json'
                    },

                    body: JSON.stringify({

                        uploadToken:
                            currentUploadToken,

                        category:
                            category

                    })

                }
            );

        const data =
            await res.json();

        if (
            !res.ok ||
            !data.success
        ) {

            throw new Error(

                data.error ||
                'อัปโหลดไม่สำเร็จ'

            );

        }

        // ป้องกันการ Upload ซ้ำ
        currentUploadToken = null;

        // ซ่อนสถานะ Loading
        resetStatus();

        // Popup สำเร็จ
        showSuccessPopup(
            data.message ||
            `จัดเก็บเอกสารเข้า Google Drive หมวด [${category}] เรียบร้อยแล้ว`
        );

    } catch (err) {

        console.error(err);

        showStatus(
            `✕ ${err.message}`,
            'error'
        );

        setButtonsDisabled(false);

    } finally {

        isUploading = false;

    }

}


// ========================================
// Loading วิเคราะห์
// ========================================

function startLoading() {

    loading.style.display = 'block';

    resultBox.style.display = 'none';

    loadingText.textContent =
        'กำลังอ่านข้อความและวิเคราะห์เอกสาร...';

    submitBtn.disabled = true;

    submitBtn.textContent =
        'กำลังวิเคราะห์...';

    resetStatus();

}


function stopLoading() {

    loading.style.display = 'none';

    submitBtn.disabled = false;

    submitBtn.textContent =
        '✦ วิเคราะห์เอกสารด้วย AI';

}


// ========================================
// ปิด/เปิดปุ่มหมวด
// ========================================

function setButtonsDisabled(value) {

    document
        .querySelectorAll(
            '.btn-confirm-category'
        )
        .forEach(button => {

            button.disabled = value;

        });

}


// ========================================
// Status
// ========================================

function resetStatus() {

    uploadStatus.style.display = 'none';

    uploadStatus.textContent = '';

    uploadStatus.className =
        'upload-status';

}


function showStatus(message, type) {

    uploadStatus.textContent = message;

    uploadStatus.className =
        'upload-status';

    if (type === 'error') {

        uploadStatus.classList.add(
            'error'
        );

    } else {

        uploadStatus.classList.add(
            'loading'
        );

    }

    uploadStatus.style.display = 'block';

}


// ========================================
// Popup สำเร็จ
// ========================================

function showSuccessPopup(message) {

    successPopupText.textContent =
        message;

    successPopup.classList.add('show');

}


function closeSuccessPopup() {

    successPopup.classList.remove('show');

}


successPopupButton.addEventListener(
    'click',
    closeSuccessPopup
);


successPopup.addEventListener(
    'click',
    e => {

        if (e.target === successPopup) {

            closeSuccessPopup();

        }

    }
);


// ========================================
// ESC ปิด Popup
// ========================================

document.addEventListener(
    'keydown',
    e => {

        if (e.key !== 'Escape') return;

        if (
            confirmPopup.classList.contains('show')
        ) {

            closeConfirmPopup();

        }

        if (
            successPopup.classList.contains('show')
        ) {

            closeSuccessPopup();

        }

    }
);


// ========================================
// ป้องกัน HTML Injection
// ========================================

function escapeHtml(text) {

    const div =
        document.createElement('div');

    div.textContent =
        text || '';

    return div.innerHTML;

}