import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from 'node:fs/promises';
import 'dotenv/config';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;

// --- File Paths ---
const USERS_DB_PATH = './users.json';
const TASKS_DB_PATH = './tasks.json';
const CONFIG_PATH = './config.json';

class Storage {
    static async read(filePath) {
        try {
            await fs.access(filePath);
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            return null;
        }
    }
    static async write(filePath, data) {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    }
}

class AltoBot {
    constructor() {
        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox'] // <-- PERBAIKAN UNTUK SERVER UBUNTU
            },
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
            }
        });
        this.genAI = null;
        this.userChats = new Map();
        this.users = {};
        this.tasks = [];
        this.config = {};
        this.ownerNumber = "6285813899649";
    }

    async initialize() {
        console.log("🚀 Memulai inisialisasi ALTO Bot...");
        await this.loadData();
        this.initializeAI();
        this.setupWhatsAppEvents();
        this.client.initialize();
    }

    async loadData() {
        this.config = await Storage.read(CONFIG_PATH) || { adminPassword: 'admin123', dailyBonus: { min: 100, max: 500 } };
        this.users = await Storage.read(USERS_DB_PATH) || {};
        this.tasks = await Storage.read(TASKS_DB_PATH) || [];
        console.log("✅ Data berhasil dimuat.");
    }

    initializeAI() {
        if (!process.env.API_KEY) {
            console.error("\n❌ ERROR: Environment variable API_KEY tidak diatur.");
            process.exit(1);
        }
        try {
            this.genAI = new GoogleGenerativeAI(process.env.API_KEY);
            console.log("✅ AI Berhasil Diinisialisasi.");
        } catch (error) {
            console.error("❌ Gagal menginisialisasi AI:", error);
            process.exit(1);
        }
    }
    
    setupWhatsAppEvents() {
        this.client.on('qr', qr => {
            console.log("📲 Pindai Kode QR ini dengan WhatsApp Anda untuk menautkan perangkat:");
            qrcode.generate(qr, { small: true });
        });
        this.client.on('ready', () => {
            console.log('✅ ALTO Bot terhubung dan siap menerima pesan!');
        });
        this.client.on('message', this.handleMessage.bind(this));
    }

    async handleMessage(message) {
        const userId = message.from;
        let user = this.users[userId];

        if (!user) {
            user = {
                balance: 0, isBlocked: false,
                lastLogin: new Date().toDateString(),
                claimedDailyBonus: false, completedTasksToday: [],
                isAdmin: false, captchaState: { isWaiting: false },
                inGame: false, gameAnswer: 0
            };
            this.users[userId] = user;
            await Storage.write(USERS_DB_PATH, this.users);
            message.reply(`👋 Halo! Selamat datang di ALTO Bot. Akun baru telah dibuat untukmu. Ketik */menu* untuk melihat apa yang bisa aku lakukan.`);
        }

        if (user.isBlocked) return;

        const today = new Date().toDateString();
        if (user.lastLogin !== today) {
            user.lastLogin = today;
            user.claimedDailyBonus = false;
            user.completedTasksToday = [];
        }

        if (user.captchaState.isWaiting) {
            await this.verifyCaptcha(message, user, message.body);
            return;
        }
        if (user.inGame) {
            await this.handleGameInput(message, user, message.body);
            return;
        }

        const command = message.body.toLowerCase().trim();
        const args = message.body.trim().split(' ').slice(1);
        const commandName = command.split(' ')[0];
        
        if (!command.startsWith('/')) {
            await this.getAiResponse(message);
            return;
        }

        let commandHandled = true;
        switch (commandName) {
            case '/menu': this.showMenu(message, user); break;
            case '/saldo': message.reply(`💰 Saldo Anda saat ini adalah: ${user.balance}`); break;
            case '/owner': message.reply(`📞 Hubungi owner di WhatsApp: ${this.ownerNumber}`); break;
            case '/klaim': await this.handleClaim(message, user); break;
            case '/tugas': this.handleListAvailableTasks(message, user); break;
            case '/selesai': await this.handleSelesai(message, user, args[0]); break;
            case '/game': await this.startGame(message, user); break;
            case '/loginadmin': this.handleLoginAdmin(message, user, args[0]); break;
            case '/clear': this.userChats.delete(userId); message.reply('🤖 Riwayat obrolan Anda telah dihapus.'); break;
            case '/gambar': message.reply("Fitur gambar sedang dalam perbaikan. Coba lagi nanti."); break;
            case '/video': message.reply("Fitur video sedang dalam perbaikan. Coba lagi nanti."); break;
            case '/listusers': this.handleListUsers(message, user); break;
            case '/blockuser': await this.handleBlockUser(message, user, args[0]); break;
            case '/unblockuser': await this.handleUnblockUser(message, user, args[0]); break;
            case '/deleteuser': await this.handleDeleteUser(message, user, args[0]); break;
            case '/addtugas': await this.handleAddTugas(message, user, args[0], args[1], args.slice(2).join(' ')); break;
            case '/listtugas': this.handleListAllTasks(message, user); break;
            case '/hapustugas': await this.handleDeleteTask(message, user, args[0]); break;
            case '/setbonus': await this.handleSetBonus(message, user, args[0], args[1]); break;
            default:
                commandHandled = false;
                break;
        }

        if (!commandHandled) {
            const model = this.genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `Pengguna mencoba perintah yang tidak ada: "${message.body}". Beri tahu mereka dengan ramah dalam Bahasa Indonesia bahwa perintah itu tidak ada dan sarankan untuk menggunakan /menu untuk melihat daftar perintah yang benar.`;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            message.reply(`🤖 ${response.text()}`);
        }
    }

    showMenu(message, user) {
        let menu = `*MENU ALTO*
--------------------------------
*/menu* - Menampilkan menu ini
*/saldo* - Cek saldo Anda
*/klaim* - Klaim bonus harian Anda
*/tugas* - Lihat tugas harian
*/selesai <id>* - Selesaikan tugas
*/gambar <teks>* - (Segera Hadir)
*/video <teks>* - (Segera Hadir)
*/owner* - Kontak owner
*/game* - Main game tebak angka
*/clear* - Hapus riwayat obrolan
--------------------------------
*ketik dengan tanda / `;

        if (user.isAdmin) {
            menu += `\n--- 👑 MENU ADMIN ---
*/listusers*
*/blockuser <nomor>*
*/unblockuser <nomor>*
*/deleteuser <nomor>*
*/addtugas <bonus> <menit> <desc>*
*/listtugas*
*/hapustugas <id>*
*/setbonus <min> <max>*
--------------------------------`;
        }
        message.reply(menu);
    }

    async startGame(message, user) {
        user.inGame = true;
        user.gameAnswer = Math.floor(Math.random() * 100) + 1;
        await Storage.write(USERS_DB_PATH, this.users);
        message.reply("🤖 Selamat datang di Game Tebak Angka! Saya telah memilih angka antara 1 dan 100. Coba tebak!\n\nKetik */exitgame* untuk keluar.");
    }
    
    async handleGameInput(message, user, input) {
        if (input.toLowerCase().trim() === '/exitgame') {
            user.inGame = false;
            await Storage.write(USERS_DB_PATH, this.users);
            message.reply("🤖 Anda telah keluar dari game.");
            this.showMenu(message, user);
            return;
        }
        const guess = parseInt(input);
        if (isNaN(guess)) {
            message.reply("🤖 Masukkan angka yang valid!");
        } else if (guess < user.gameAnswer) {
            message.reply("🤖 Terlalu rendah! Coba lagi.");
        } else if (guess > user.gameAnswer) {
            message.reply("🤖 Terlalu tinggi! Coba lagi.");
        } else {
            const reward = 250;
            user.balance += reward;
            user.inGame = false;
            await Storage.write(USERS_DB_PATH, this.users);
            message.reply(`🎉 Selamat! Anda menebak dengan benar. Jawabannya adalah ${user.gameAnswer}.\nAnda mendapatkan ${reward} saldo! Saldo baru Anda: ${user.balance}.`);
            this.showMenu(message, user);
        }
    }
    
    async handleClaim(message, user) {
        if (user.claimedDailyBonus) {
            message.reply("Anda sudah mengklaim bonus harian hari ini. Coba lagi besok.");
            return;
        }
        const captchaText = this.generateCaptcha();
        user.captchaState = { isWaiting: true, type: 'claim', answer: captchaText };
        await Storage.write(USERS_DB_PATH, this.users);
        message.reply(`🤖 Untuk verifikasi, silakan ketik teks berikut:\n\n*${captchaText}*`);
    }

    handleListAvailableTasks(message, user) {
        const availableTasks = this.tasks.filter(task => !user.completedTasksToday.includes(task.id));
        if (availableTasks.length === 0) {
            message.reply("Tidak ada tugas yang tersedia saat ini atau Anda sudah menyelesaikan semuanya.");
            return;
        }
        let taskList = "--- 📝 Tugas Harian Tersedia ---\n";
        availableTasks.forEach(task => {
            taskList += `*ID:* ${task.id} | *Bonus:* ${task.bonus} | *Durasi:* ${task.duration} menit\n*Tugas:* ${task.description}\n\n`;
        });
        message.reply(taskList);
    }

    async handleSelesai(message, user, taskIdStr) {
        const taskId = parseInt(taskIdStr);
        if (isNaN(taskId)) {
            message.reply("ID tugas tidak valid. Gunakan */tugas* untuk melihat ID yang tersedia.");
            return;
        }
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) {
            message.reply("Tugas dengan ID tersebut tidak ditemukan.");
            return;
        }
        if (user.completedTasksToday.includes(taskId)) {
            message.reply("Anda sudah menyelesaikan tugas ini hari ini.");
            return;
        }
        const captchaText = this.generateCaptcha();
        const timer = setTimeout(() => {
            const currentUserState = this.users[message.from];
            if (currentUserState?.captchaState.isWaiting && currentUserState.captchaState.task?.id === taskId) {
                currentUserState.captchaState = { isWaiting: false };
                Storage.write(USERS_DB_PATH, this.users);
                message.reply("❌ Waktu habis! Penyelesaian tugas dibatalkan.");
            }
        }, task.duration * 60 * 1000);

        user.captchaState = { isWaiting: true, type: 'task', task, answer: captchaText, timerId: timer };
        await Storage.write(USERS_DB_PATH, this.users);
        message.reply(`🤖 Untuk verifikasi, silakan ketik teks berikut dalam *${task.duration} menit*:\n\n*${captchaText}*`);
    }

    generateCaptcha(length = 6) {
        return Math.random().toString(36).substring(2, 2 + length).toUpperCase();
    }

    async verifyCaptcha(message, user, userInput) {
        const { type, task, answer, timerId } = user.captchaState;
        if (timerId) clearTimeout(timerId);
        user.captchaState = { isWaiting: false };

        if (userInput.trim().toUpperCase() === answer) {
            message.reply("✅ Captcha benar!");
            if (type === 'task') {
                user.balance += task.bonus;
                user.completedTasksToday.push(task.id);
                message.reply(`🎉 Selamat! Anda mendapatkan ${task.bonus} saldo. Saldo baru: ${user.balance}.`);
            } else if (type === 'claim') {
                const { min, max } = this.config.dailyBonus;
                const reward = Math.floor(Math.random() * (max - min + 1)) + min;
                user.balance += reward;
                user.claimedDailyBonus = true;
                message.reply(`🎉 Selamat! Anda mendapatkan bonus harian ${reward} saldo. Saldo baru: ${user.balance}`);
            }
        } else {
            message.reply("❌ Captcha salah. Proses dibatalkan.");
        }
        await Storage.write(USERS_DB_PATH, this.users);
        this.showMenu(message, user);
    }

    checkAdmin(message, user) {
        if (!user.isAdmin) {
            message.reply("❌ Perintah ini hanya untuk admin.");
            return false;
        }
        return true;
    }

    handleLoginAdmin(message, user, password) {
        if (password === this.config.adminPassword) {
            user.isAdmin = true;
            Storage.write(USERS_DB_PATH, this.users);
            message.reply("👑 Anda berhasil masuk sebagai admin.");
        } else {
            message.reply("❌ Kata sandi admin salah.");
        }
    }
    
    handleListUsers(message, user) {
        if (!this.checkAdmin(message, user)) return;
        let userList = "--- 👥 Daftar Pengguna ---\n";
        for (const id in this.users) {
            const u = this.users[id];
            userList += `*ID:* ${id.split('@')[0]}\n*Saldo:* ${u.balance}\n*Diblokir:* ${u.isBlocked}\n\n`;
        }
        message.reply(userList);
    }
    
    async handleBlockUser(message, user, userIdToBlock) {
        if (!this.checkAdmin(message, user)) return;
        const targetId = userIdToBlock.endsWith('@c.us') ? userIdToBlock : `${userIdToBlock}@c.us`;
        if (this.users[targetId]) {
            this.users[targetId].isBlocked = true;
            await Storage.write(USERS_DB_PATH, this.users);
            message.reply(`✅ Pengguna ${targetId.split('@')[0]} telah diblokir.`);
        } else {
            message.reply(`❌ Pengguna ${userIdToBlock} tidak ditemukan.`);
        }
    }
    
    async handleUnblockUser(message, user, userIdToUnblock) {
        if (!this.checkAdmin(message, user)) return;
        const targetId = userIdToUnblock.endsWith('@c.us') ? userIdToUnblock : `${userIdToUnblock}@c.us`;
        if (this.users[targetId]) {
            this.users[targetId].isBlocked = false;
            await Storage.write(USERS_DB_PATH, this.users);
            message.reply(`✅ Blokir untuk pengguna ${targetId.split('@')[0]} telah dibuka.`);
        } else {
            message.reply(`❌ Pengguna ${userIdToUnblock} tidak ditemukan.`);
        }
    }

    async handleDeleteUser(message, user, userIdToDelete) {
        if (!this.checkAdmin(message, user)) return;
        const targetId = userIdToDelete.endsWith('@c.us') ? userIdToDelete : `${userIdToDelete}@c.us`;
        if (this.users[targetId]) {
            delete this.users[targetId];
            await Storage.write(USERS_DB_PATH, this.users);
            message.reply(`✅ Pengguna ${targetId.split('@')[0]} telah dihapus.`);
        } else {
            message.reply(`❌ Pengguna ${userIdToDelete} tidak ditemukan.`);
        }
    }

    async handleAddTugas(message, user, bonusStr, durationStr, description) {
        if (!this.checkAdmin(message, user)) return;
        const bonus = parseInt(bonusStr);
        const duration = parseInt(durationStr);
        if (isNaN(bonus) || isNaN(duration) || !description || duration <= 0) {
            message.reply("Penggunaan salah. Contoh: /addtugas 150 5 Jawab pertanyaan AI");
            return;
        }
        const newId = this.tasks.length > 0 ? Math.max(...this.tasks.map(t => t.id)) + 1 : 1;
        this.tasks.push({ id: newId, bonus, duration, description });
        await Storage.write(TASKS_DB_PATH, this.tasks);
        message.reply(`✅ Tugas baru ditambahkan dengan ID: ${newId}.`);
    }

    handleListAllTasks(message, user) {
        if (!this.checkAdmin(message, user)) return;
        if (this.tasks.length === 0) {
            message.reply("Belum ada tugas yang dibuat.");
            return;
        }
        let taskList = "--- 📝 Semua Tugas ---\n";
        this.tasks.forEach(task => {
            taskList += `*ID:* ${task.id} | *Bonus:* ${task.bonus} | *Durasi:* ${task.duration} menit\n*Tugas:* ${task.description}\n\n`;
        });
        message.reply(taskList);
    }
    
    async handleDeleteTask(message, user, taskIdStr) {
        if (!this.checkAdmin(message, user)) return;
        const taskId = parseInt(taskIdStr);
        const taskIndex = this.tasks.findIndex(t => t.id === taskId);
        if (taskIndex > -1) {
            this.tasks.splice(taskIndex, 1);
            await Storage.write(TASKS_DB_PATH, this.tasks);
            message.reply(`✅ Tugas dengan ID ${taskId} telah dihapus.`);
        } else {
            message.reply("❌ Tugas dengan ID tersebut tidak ditemukan.");
        }
    }
    
    async handleSetBonus(message, user, minStr, maxStr) {
        if (!this.checkAdmin(message, user)) return;
        const min = parseInt(minStr);
        const max = parseInt(maxStr);
        if (isNaN(min) || isNaN(max) || min > max) {
            message.reply("Penggunaan salah. Contoh: /setbonus 100 500");
            return;
        }
        this.config.dailyBonus = { min, max };
        await Storage.write(CONFIG_PATH, this.config);
        message.reply(`✅ Bonus klaim harian telah diatur ke rentang ${min} - ${max}.`);
    }

    async getAiResponse(message) {
        try {
            const userId = message.from;
            if (!this.userChats.has(userId)) {
                 const model = this.genAI.getGenerativeModel({ 
                    model: "gemini-1.5-flash",
                    systemInstruction: "Kamu adalah ALTO, bot WhatsApp yang ramah dan membantu. Selalu balas dalam Bahasa Indonesia. Jangan gunakan format markdown.",
                });
                this.userChats.set(userId, model.startChat());
            }
            
            const chat = this.userChats.get(userId);
            const result = await chat.sendMessage(message.body);
            const response = await result.response;
            const botResponse = response.text();
            message.reply(botResponse.trim());

        } catch (error) {
            console.error("\n❌ Gemini API error:", error);
            message.reply("🤖 Maaf, terjadi kesalahan saat menghubungi AI. Coba lagi nanti.");
        }
    }
}

const bot = new AltoBot();
bot.initialize();
