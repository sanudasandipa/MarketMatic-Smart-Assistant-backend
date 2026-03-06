# Deploying the Backend to an Azure VM with Docker

This guide walks you through provisioning an Azure VM, installing Docker, and running
the full stack (Node.js backend + MongoDB + ChromaDB) with Docker Compose.

---

## Architecture

```
Internet
   │
   ├─ :8000  ──▶  backend (Node.js/Express)
   │                  │
   │                  ├─ mongo:27017   (MongoDB container, internal only)
   │                  └─ chroma:8000   (ChromaDB container, internal only)
   │
   └─ :8001  ──▶  ChromaDB  (optional direct access)
```

---

## Step 1 – Create the Azure VM

1. Go to **Azure Portal → Virtual Machines → Create**.
2. Recommended settings:

   | Setting | Value |
   |---|---|
   | Image | Ubuntu Server 22.04 LTS |
   | Size | Standard_B2s (2 vCPU, 4 GB RAM) minimum |
   | Authentication | SSH public key (recommended) |
   | Inbound ports | 22 (SSH), 8000 (API) |

3. After creation, note the **Public IP address**.

---

## Step 2 – Open required ports in the Network Security Group (NSG)

In the Azure Portal, go to **VM → Networking** and add inbound rules:

| Port | Protocol | Purpose |
|---|---|---|
| 22 | TCP | SSH access |
| 8000 | TCP | Backend API |

> Do **not** expose port 27017 (MongoDB) or 8001 (ChromaDB) to the internet.

---

## Step 3 – Connect to the VM via SSH

```bash
ssh -i <your-private-key.pem> azureuser@<VM_PUBLIC_IP>
```

---

## Step 4 – Install Docker & Docker Compose on the VM

```bash
# Update packages
sudo apt-get update && sudo apt-get upgrade -y

# Install Docker
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow current user to run Docker without sudo
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version
docker compose version
```

---

## Step 5 – Copy the backend to the VM

**Option A – Transfer files with `scp`** (from your local machine):

```bash
scp -i <your-private-key.pem> -r ./backend azureuser@<VM_PUBLIC_IP>:~/smart-assistant-backend
```

**Option B – Use Git** (on the VM):

```bash
git clone <your-repo-url> smart-assistant-backend
cd smart-assistant-backend/backend
```

---

## Step 6 – Create the `.env` file on the VM

```bash
cd ~/smart-assistant-backend   # or wherever you copied the backend folder

cp .env.example .env
nano .env
```

Fill in the values:

```env
# Server
PORT=8000
NODE_ENV=production

# MongoDB credentials (must match docker-compose.yml)
MONGO_ROOT_USER=admin
MONGO_ROOT_PASS=<a-strong-password>

# JWT
JWT_SECRET=<a-long-random-secret-minimum-32-chars>
JWT_EXPIRES_IN=7d

# Frontend origin (your Next.js URL or Azure static web app URL)
FRONTEND_URL=https://<your-frontend-domain>

# Superadmin seed (run once then you can remove these)
SUPERADMIN_EMAIL=superadmin@platform.com
SUPERADMIN_PASSWORD=SuperAdmin@2024
SUPERADMIN_NAME=Platform Superadmin
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

---

## Step 7 – Build and start all containers

```bash
# From the backend directory that contains docker-compose.yml
docker compose up -d --build
```

Check that all containers are healthy:

```bash
docker compose ps
```

You should see `healthy` for all three services.

---

## Step 8 – Seed the superadmin (first-time only)

```bash
docker compose exec backend node src/scripts/seedSuperadmin.js
```

---

## Step 9 – Verify the deployment

```bash
curl http://<VM_PUBLIC_IP>:8000/health
```

Expected response:
```json
{"status":"ok","service":"smart-assistant-backend","timestamp":"..."}
```

---

## Useful commands

```bash
# View live logs
docker compose logs -f

# Logs for a specific service
docker compose logs -f backend

# Restart a service
docker compose restart backend

# Stop everything
docker compose down

# Stop and remove volumes (WARNING: deletes all data)
docker compose down -v

# Pull latest images and redeploy
git pull
docker compose up -d --build
```

---

## Step 10 – (Optional) Set up a reverse proxy with HTTPS

For production, put **Nginx + Certbot (Let's Encrypt)** in front of the backend:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Create Nginx site config
sudo nano /etc/nginx/sites-available/smart-assistant
```

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass         http://localhost:8000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/smart-assistant /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Obtain SSL certificate
sudo certbot --nginx -d api.yourdomain.com
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `backend` container keeps restarting | Run `docker compose logs backend` to see the error |
| MongoDB connection refused | Check `MONGO_ROOT_USER`/`MONGO_ROOT_PASS` match in `.env` and `docker-compose.yml` |
| ChromaDB unhealthy | Run `docker compose logs chroma`; make sure `chroma_data` volume has write permissions |
| Port 8000 not reachable | Verify NSG inbound rule for port 8000 is added in Azure Portal |
