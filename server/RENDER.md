# 5PLUS website on Render

Render runs this folder: build command `echo "no build needed"`, start command `cd server && npm start`, Node 22.
Private settings (Render → the service → Environment): DATABASE_URL (Supabase Session pooler URI), JWT_SECRET,
COOKIE_SECURE=true, ADMIN_NAME, ADMIN_PHONE, ADMIN_PIN, ADMIN_PASSWORD, FCM_SERVICE_ACCOUNT (Firebase key, optional).
Never commit these values.
