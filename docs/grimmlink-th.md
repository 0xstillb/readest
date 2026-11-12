# 📚 Readest + GrimmLink: คู่มือภาษาไทย

[English](../README.md#-grimmlink-fork) · [ดาวน์โหลดรุ่นล่าสุด](https://github.com/0xstillb/readest/releases/latest)

## ติดตั้งและเชื่อมต่อ

1. ดาวน์โหลดไฟล์ติดตั้งสำหรับเครื่องของคุณ หรือ APK Android arm64 จากหน้ารุ่นล่าสุดของ fork นี้
2. เปิด Grimmory และ GrimmLink Adapter ให้ทำงาน แล้วเชื่อมอุปกรณ์เข้ากับเครือข่ายบ้านหรือ Tailscale ดูวิธีติดตั้ง server ใน [คู่มือ Adapter](https://github.com/0xstillb/grimmlink-adapter)
3. เปิด **Settings → Integrations → GrimmLink** ใน Readest กรอก URL ของ Adapter และบัญชี Grimmory แล้วกด **Connect** เช่น `http://192.168.1.116:8085` โดยเปลี่ยนเป็น IP ของเครื่องคุณเอง
4. เลือก shelf ที่ต้องการใน **Grimmory Shelves** แล้วกด **Sync** จากนั้นเปิดหนังสือที่ดาวน์โหลดมา
5. ใน **Sync Options** เลือกวิธีจัดการข้อมูลขัดกัน และเปิดข้อมูลที่ต้องการซิงก์ ได้แก่ ตำแหน่งอ่าน, highlights/bookmarks/ratings, reading sessions และ reading status

`localhost` หมายถึงอุปกรณ์ที่เปิด Readest อยู่เอง ถ้า Adapter อยู่บน Pi ให้ใช้ IP ของ Pi ใน LAN หรือ Tailscale แทน PDF ใช้เลขหน้าสำหรับ bookmark ส่วน EPUB ใช้ตำแหน่งภายในหนังสือ

## 📖 Simple UI

เปิด **Simple UI Mode** ในการตั้งค่า Library แล้วเลือกจำนวนคอลัมน์จากการตั้งค่า grid ตามปกติ

- ปิด **Continuous Library scrolling** เพื่อแบ่งหน้า: grid 1 แสดงทีละเล่ม ส่วน grid 2 และ 3 แสดงได้สูงสุดสองแถวต่อหน้า
- เปิดตัวเลือกเดียวกันเพื่อเลื่อน Library ต่อเนื่อง
- เลือกหน้า Home ให้แสดงเฉพาะ **Currently Reading** หรือแสดง **Recently read** ด้วยได้ รวมถึงตั้งชื่อหนังสือบนปกและขนาดไอคอนแถบล่าง
- ใช้ Simple UI ร่วมกับโหมด e-ink ได้

## 🔧 เมื่อเชื่อมต่อไม่ได้

ตรวจว่า Adapter ทำงานอยู่ URL และพอร์ตถูกต้อง อุปกรณ์อยู่ใน LAN หรือเชื่อม Tailscale แล้ว และเลือก shelf ที่ต้องการ หากเปลี่ยนระหว่างแอปที่เซ็นด้วยคนละคีย์ ควรสำรอง Library ก่อนติดตั้ง
