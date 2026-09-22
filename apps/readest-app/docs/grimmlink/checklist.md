# GrimmLink production test checklist

ขอบเขต: ทดสอบเฉพาะ Readest fork ฝั่ง client เท่านั้น ห้ามแก้ Grimmory server
ระหว่างการทดสอบทุกกรณีให้บันทึก app build/version, Grimmory version, URL ที่ใช้,
อุปกรณ์, network, เวลาเริ่ม/จบ และแนบ diagnostics export ที่ลบข้อมูลลับแล้ว

## 0. Preconditions

- [ ] ใช้ Readest build ล่าสุดจาก workspace ไม่ใช่ build เก่าใน `Program Files`
- [ ] มีบัญชีทดสอบ Grimmory แยกจากบัญชีใช้งานจริง
- [ ] มีหนังสือทดสอบอย่างน้อย EPUB เล็ก, EPUB/PDF ขนาดใหญ่กว่า 15 MB
- [ ] มีหนังสือเล่มเดียวกันในอย่างน้อยสองอุปกรณ์สำหรับทดสอบ conflict
- [ ] ยืนยันว่าไม่มี password, userkey, cookie หรือ auth header ในหลักฐาน/ภาพหน้าจอ
- [ ] ยืนยันว่าไม่ได้แก้ไฟล์หรือ config ใน Grimmory server

## 1. LAN connection

ใช้ URL ตัวอย่าง `http://192.168.1.203:6060` ขณะอุปกรณ์อยู่ Wi‑Fi เดียวกัน

- [ ] Grimmory UI เปิดได้
- [ ] Readest Test connection สำเร็จ
- [ ] GrimmLink diagnostics แสดง `connected`
- [ ] Pull capabilities สำเร็จ
- [ ] Pull progress สำเร็จโดยไม่สร้าง push ซ้ำก่อน pull จบ
- [ ] Push progress สำเร็จและ queue กลับเป็น 0
- [ ] Session ถูกปิดเมื่อ background และเริ่มใหม่เมื่อ foreground
- [ ] self-signed certificate เปิดได้เฉพาะ LAN เมื่อจำเป็น
- [ ] ปิด self-signed แล้ว server certificate ที่ไม่ถูกต้องถูกปฏิเสธ

## 2. Public URL / Cloudflare Tunnel

ต้องใช้ HTTPS เท่านั้น เช่น `https://...`; ห้ามใช้ public plain HTTP กับ credential จริง

- [ ] DNS/Cloudflare Tunnel หรือ reverse proxy ส่งต่อไป Grimmory ได้
- [ ] HTTPS certificate valid และ hostname ตรง
- [ ] Readest เชื่อมต่อ public URL สำเร็จ
- [ ] `allowSelfSignedCertificate` ไม่มีผลกับ public URL
- [ ] Web ใช้ Readest proxy ได้โดยไม่ต้องพึ่ง CORS
- [ ] Tauri/Windows และ Android เชื่อมต่อ public URL ได้
- [ ] ตรวจว่า error ไม่เปิดเผย userkey/password/headers
- [ ] ทดสอบ timeout และ server 5xx แล้วแสดง category ถูกต้อง

## 3. Offline → online

- [ ] เปิดหนังสือขณะ online และ pull สำเร็จ
- [ ] ตัด network ระหว่างอ่าน
- [ ] เปลี่ยน progress แล้วตรวจ status เป็น `offline` หรือ `queued`
- [ ] เพิ่ม session/progress/status/metadata ระหว่าง offline
- [ ] ปิดแอปก่อน replay แล้วเปิดใหม่
- [ ] queue ยังอยู่หลัง restart
- [ ] เปิด network กลับ
- [ ] กด `Retry pending` แล้วแต่ละ category replay แยกกัน
- [ ] retry ใช้ exponential backoff และไม่ยิง request ถี่เกินกำหนด
- [ ] queue สำเร็จลดเหลือ 0 และมี `Last successful sync`
- [ ] invalid/conflict row ไม่ถูก replay ซ้ำ และ `Clear invalid` ลบเฉพาะ row เหล่านั้น

## 4. Conflict and data correctness

- [ ] อุปกรณ์ A และ B อ่านเล่มเดียวกันไปคนละตำแหน่ง
- [ ] ทำให้ remote progress ใหม่กว่า local
- [ ] Dialog แสดง `Continue from this device` และ `Continue from Grimmory`
- [ ] Dialog แสดง device/percentage/page/time ที่อ่านเข้าใจได้
- [ ] Dialog ไม่แสดง CFI, XPointer, hash, book ID หรือ internal ID
- [ ] เลือก local แล้ว local ถูก push เป็นค่าล่าสุดครั้งเดียว
- [ ] เลือก Grimmory แล้ว remote ถูก apply และไม่ stale re-push กลับ
- [ ] same-device echo ไม่สร้าง conflict ปลอม
- [ ] malformed/invalid remote data ไม่ทำให้ local progress หาย

## 5. Windows lifecycle

- [ ] ติดตั้ง build ล่าสุดและบันทึก path/version
- [ ] เปิดเล่มแล้วเริ่ม session
- [ ] minimize/background 10 นาที แล้วกลับมาอ่านต่อ 10 นาที
- [ ] ตรวจว่าได้ session ประมาณ 10 + 10 นาที ไม่ใช่ 20/50 นาทีผิดพลาด
- [ ] sleep/wake แล้ว pull/push ทำงานต่อ
- [ ] ปิด process ระหว่าง queue write แล้วเปิดใหม่
- [ ] queue และ diagnostics ยังอยู่หลัง restart
- [ ] ตัด network adapter แล้ว reconnect
- [ ] ทดสอบ large EPUB/PDF และยืนยันว่า UI ไม่ค้างโดยไม่มี status

## 6. Android lifecycle

- [ ] `adb devices` แสดง physical device
- [ ] ติดตั้ง APK build ล่าสุด
- [ ] ใช้ LAN URL ขณะอยู่ Wi‑Fi เดียวกัน
- [ ] ใช้ public HTTPS URL ผ่าน mobile network
- [ ] background/foreground ระหว่างอ่าน
- [ ] activity recreation/หมุนจอ (ถ้าเปิดใช้)
- [ ] force-close หลัง queue write แล้วเปิดใหม่
- [ ] network เปลี่ยน Wi‑Fi ↔ mobile data
- [ ] offline queue replay หลังกลับ online
- [ ] storage permission และหนังสือขนาดใหญ่ไม่ทำให้ import/sync ค้างเงียบ

## 7. Diagnostics and security

- [ ] สถานะแสดง idle/syncing/synced/queued/retrying/offline/auth-error/server-error/invalid/conflict ตามเหตุการณ์
- [ ] error แยก Auth / Network / Server / Conflict / Invalid data ถูกต้อง
- [ ] timeout request และ download แยกกันตามที่กำหนด
- [ ] retry count และ next retry time แสดงได้
- [ ] Export diagnostics เปิดอ่านได้
- [ ] Export ไม่มี password, userkey, cookie, Authorization, private headers, book content หรือ annotation text
- [ ] public HTTP ถูกระบุว่าไม่เหมาะกับ production และเปลี่ยนเป็น HTTPS ก่อน release

## 8. Evidence record

| Run | Device/build | URL/network | Scenario | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  | ☐ Pass ☐ Fail ☐ Blocked |  |
|  |  |  |  | ☐ Pass ☐ Fail ☐ Blocked |  |
|  |  |  |  | ☐ Pass ☐ Fail ☐ Blocked |  |

## Release gate

- [ ] ทุกข้อ LAN ผ่าน
- [ ] Public HTTPS/Tunnel ผ่าน
- [ ] Offline → online ผ่าน
- [ ] Windows lifecycle ผ่าน
- [ ] Android lifecycle ผ่าน
- [ ] Diagnostics redaction ผ่าน
- [ ] ไม่มี Grimmory server change
- [ ] `git diff --check` ผ่าน
- [ ] Focused GrimmLink tests ผ่าน
- [ ] Build/install artifact ถูกบันทึกและตรวจสอบซ้ำได้
