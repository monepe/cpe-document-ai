async function checkAuthError() {
    try {
        const res = await fetch('/api/auth-error');
        const data = await res.json();

        if (data.error) {
            const alertBox =
                document.getElementById('alertBox');

            alertBox.textContent =
                `⚠️ ${data.error}`;

            alertBox.style.display = 'block';
        }

    } catch (err) {
        console.error(
            'ตรวจสอบสถานะ Login ไม่สำเร็จ:',
            err
        );
    }
}

window.addEventListener(
    'DOMContentLoaded',
    checkAuthError
);