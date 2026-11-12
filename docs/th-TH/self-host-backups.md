# สำรองและกู้คืน

สำรองฐานข้อมูลกับข้อมูลแอป เก็บสำเนาเข้ารหัสนอกเซิร์ฟเวอร์ และกู้เมื่อจำเป็น

## Development (checkout)

```bash
./scripts/backup.sh
```

ได้ dump Postgres และ archive `data/` ใต้ `backups/<stamp>/` ก่อน restore หยุด bot computers และบริการที่เขียน DB/ไฟล์

```bash
./scripts/restore.sh backups/<stamp>
```

## Production

ติดตั้ง `infra/compose/backup-prod.sh` เป็น timer ได้ snapshot ใต้ `/var/backups/cortexai-agent-hub` ปรับ `CORTEXAI_AGENT_HUB_DEPLOY_DIR` ใน `/etc/cortexai-agent-hub/backup.env` ถ้า deploy ไม่ใช่ `/srv/cortexai-agent-hub`

**`docker compose down -v` ลบ Postgres ทั้งหมด** — สำรองก่อนทุกครั้ง

## สำรองเข้ารหัส (age)

สร้างคู่กุญแจนอกเซิร์ฟเวอร์ เก็บ private key ออฟไลน์ ตั้ง public key ใน env:

```env
CORTEXAI_AGENT_HUB_BACKUP_AGE_RECIPIENTS=age1exampleprimaryrecipient age1examplerecoveryrecipient
# or: CORTEXAI_AGENT_HUB_BACKUP_AGE_RECIPIENTS_FILE=/etc/cortexai-agent-hub/backup-recipients.txt
```

ถ้าเคยเข้ารหัสแล้ว การรันโดยไม่มี recipients จะ fail (ยกเว้นตั้ง `CORTEXAI_AGENT_HUB_BACKUP_ALLOW_PLAINTEXT=1`)

อัปโหลดนอกไซต์: `CORTEXAI_AGENT_HUB_BACKUP_OFFSITE_REMOTE` และการตั้ง rclone ในไฟล์ env เดียวกัน — ต้องมีการเข้ารหัสก่อน

## PITR (ทางเลือก)

ปิดตามค่าเริ่มต้น ใช้ production Compose กับ Postgres 18 เปิดด้วย profile และตั้งชื่อ env หลัก:

```env
COMPOSE_PROFILES=pitr
PITR_DATABASE_PASSWORD=replace-with-openssl-rand-hex-24
PITR_BUCKET=example-cortexai-agent-hub-pitr
PITR_ENDPOINT=https://s3.example.com
PITR_REGION=example-region
PITR_ACCESS_KEY_ID=replace-me
PITR_SECRET_ACCESS_KEY=replace-me
PITR_AGE_RECIPIENTS=age1exampleprimaryrecipient
```

```bash
sudo infra/compose/pitr.sh enable
```

ครอบคลุมเฉพาะฐานข้อมูล ยังต้องมี nightly backup สำหรับไฟล์แอป

กู้ encrypted backup ใช้ `infra/compose/backup-drill.sh` ที่เครื่องที่มี identity file **อย่า extract appdata ทับ volume ที่กำลังใช้งาน**

ย้ายบัญชีระหว่าง install: **ตั้งค่า (Settings) → Export data** บนเครื่องเก่า และ **Import data** บนเครื่องใหม่ credential ต้องเชื่อมใหม่
