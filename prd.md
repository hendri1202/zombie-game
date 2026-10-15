# PRD — Dead District: Horde Survival (working title)

> **Dokumen ini adalah brief produk sekaligus prompt implementasi untuk AI coding agent.** Nama *Dead District* hanya nama kerja; buat identitas, UI, peta, audio, dan desain original. Game ini terinspirasi dari genre horde-survival FPS serta ritme permainan yang menggabungkan tekanan gerombolan ala *World War Z* dan pertempuran kooperatif ala *Left 4 Dead 2*, tetapi **jangan menyalin** aset, kode, level, UI, karakter, nama, audio, atau materi berhak cipta dari game tersebut.

## 1. Ringkasan Produk

Bangun game zombie 3D first-person shooter (FPS) yang berjalan langsung di browser desktop memakai Three.js. Pemain menjelajahi satu ruas kota yang ditinggalkan, melawan zombie dengan senjata api, mengambil amunisi/medkit, dan bertahan dari gelombang musuh yang makin sulit.

Prioritas utama: **fondasi game benar-benar dapat dimainkan**, karakter zombie 3D beranimasi, AI mengejar dan menyerang, penembakan terasa responsif, dan performa cukup baik untuk dikembangkan menjadi horde yang lebih besar. Jangan memulai dengan janji simulasi ratusan zombie realistis sebelum satu zombie, gerakan pemain, tembakan, dan navigasi berfungsi stabil.

### Visi

- Pengalaman FPS survival yang tegang dengan banyak zombie datang dari berbagai arah.
- Zombie bukan sekadar kubus/kapsul: gunakan model humanoid 3D bertekstur dengan rig dan animasi jika aset yang layak tersedia.
- Gameplay dan dunia orisinal, bukan remake atau clone dari IP lain.
- Proyek awal murah, tanpa backend, tanpa akun, dan tanpa API berbayar.

### Target platform

- Browser desktop modern: Chrome, Edge, Firefox, dan Safari versi yang mendukung WebGL 2 dan Pointer Lock.
- Input utama: keyboard dan mouse.
- Tidak perlu mendukung mobile touch di MVP. Pastikan UI tidak rusak pada ukuran layar yang lebih kecil, tetapi gameplay touch boleh menjadi fase terpisah.

## 2. Sasaran dan Non-Sasaran

### Sasaran MVP

1. Pemain bisa memulai game, berjalan, berlari, melihat dengan mouse, menembak, mengisi ulang, menerima damage, mati, dan mengulang game.
2. Setidaknya satu model zombie eksternal 3D bertekstur berhasil dimuat dari file lokal, dengan animasi berjalan/berlari, attack, hit/death jika tersedia.
3. Zombie punya state AI yang jelas: spawn, idle/wander, chase, attack, hit reaction, death, dan despawn/cleanup.
4. Zombie menggunakan navigasi sederhana yang bisa menghindari bangunan dan kendaraan besar; mereka tidak hanya bergerak lurus menembus semua obstacle.
5. Ada variasi musuh Walker, Runner, dan Tank, meski beberapa variasi awal boleh memakai model dasar yang sama dengan statistik/warna/animasi yang berbeda jika pilihan aset terbatas. Jangan menyatakan model berbeda jika sebenarnya hanya satu.
6. Satu peta kota kecil yang punya jalan, trotoar, bangunan sederhana, kendaraan terbengkalai, pagar/barikade, lampu, dan titik spawn zombie.
7. HUD menampilkan health, ammo/magazine, jumlah kill, wave, crosshair, status pause/game over, dan notifikasi penting.
8. Ada sistem wave dengan kesulitan meningkat secara terkontrol.
9. Ada asset credits dan instruksi menjalankan proyek.
10. Build, typecheck, dan test berhasil; kegagalan atau keterbatasan harus dilaporkan, bukan disembunyikan.

### Bukan sasaran MVP

- Multiplayer online, server, akun, matchmaking, leaderboard online, persistence cloud, atau monetisasi.
- Menyalin campaign, peta, suara, karakter, special infected, nama senjata, atau UI dari World War Z / Left 4 Dead.
- Ragdoll fisik penuh, pemotongan tubuh/gore kompleks, destruksi bangunan, panjat-horde seperti simulasi fisik penuh, atau 100+ zombie skeletal ber-AI kompleks sebagai syarat MVP.
- Membuat semua model/tekstur dari nol jika aset legal yang cocok sudah tersedia.
- Menambahkan React, Redux, backend, database, atau physics engine tanpa alasan teknis yang jelas.

## 3. Tech Stack

Gunakan stack minimal berikut:

- **Language:** TypeScript dengan `strict: true`.
- **Build/dev server:** Vite dengan template `vanilla-ts`.
- **3D engine:** Three.js.
- **3D assets:** glTF 2.0 / `.glb` sebagai format utama.
- **Model loader:** `GLTFLoader` dari `three/addons/loaders/GLTFLoader.js`.
- **Character animation:** `AnimationMixer`, `AnimationAction`, dan `AnimationClip` dari Three.js.
- **Input FPS:** implementasi keyboard/mouse sendiri menggunakan Pointer Lock API atau kontrol Three.js resmi bila benar-benar sesuai; jangan memasang dua sistem kontrol yang saling bentrok.
- **UI:** HTML + CSS + TypeScript biasa, dengan overlay DOM untuk menu dan HUD. Jangan membuat seluruh HUD sebagai mesh 3D.
- **Audio:** Web Audio API atau audio file lokal yang lisensinya terverifikasi. Semua audio harus bisa dimatikan dari UI.
- **Testing:** Vitest untuk game logic yang bisa diuji tanpa WebGL; Playwright boleh ditambahkan untuk smoke test browser jika lingkungan mendukungnya.
- **Package manager:** npm, dengan lockfile yang disimpan di repository.
- **Physics:** mulai dengan collision/raycast sederhana dan kinematic movement yang ditulis dengan jelas. Tambahkan Rapier hanya jika prototipe membuktikan bahwa kebutuhan collision/physics tidak masuk akal diselesaikan dengan sistem ringan. Jangan menambahkan dependency hanya untuk terlihat canggih.

Pilih versi stable yang kompatibel saat implementasi. Periksa dokumentasi resmi, hindari versi beta/canary kecuali ada alasan dan ditulis dalam catatan keputusan. Jangan menebak nomor versi terbaru secara manual; biarkan package manager memilih versi kompatibel lalu commit `package-lock.json`.

### Referensi dokumentasi teknis

- Vite: https://vite.dev/guide/
- Three.js docs: https://threejs.org/docs/
- GLTFLoader: https://threejs.org/docs/pages/GLTFLoader.html
- AnimationMixer: https://threejs.org/docs/pages/AnimationMixer.html
- InstancedMesh: https://threejs.org/docs/pages/InstancedMesh.html
- Rapier JS, hanya bila dibutuhkan: https://rapier.rs/docs/

## 4. Riset Demo Referensi (pelajari, jangan salin)

Buka dan uji demo ini jika masih tersedia. Amati feel kontrol, wave, UI, pembagian file, dan cara mereka mengatur aset. **Gunakan sebagai referensi pembelajaran saja. Jangan copy source code atau mengambil asetnya tanpa izin/lisensi yang sesuai.**

1. **Zombie Survival FPS — live demo:** https://apoorvdarshan.github.io/zombie-game/  
   Source: https://github.com/apoorvdarshan/zombie-game  
   Referensi kontrol FPS, wave survival, senjata, health pack, dan empat kelas statistik zombie.
2. **Zeta Forces: Zombie Shooter — live demo:** https://threejs-zombieshooter-game.vercel.app/  
   Source: https://github.com/RohanVashisht1234/threejs-zombieshooter-game  
   Referensi game shooter 3D dengan model GLTF dan misi sederhana. Repository mencantumkan aset eksternal, jadi jangan mengasumsikan aset tersebut boleh digunakan kembali.
3. **Claude\Zombies — live demo:** https://zombies.jwhitton.com/  
   Source: https://github.com/justinw916-sketch/claude-zombies  
   Referensi alternatif procedural/zero-binary-asset untuk melihat wave, sistem senjata, dan pendekatan optimasi. Gunakan sebagai perbandingan, bukan keharusan visual.

Jika URL demo mati, jangan berhenti. Baca README/source repository yang bersangkutan bila dapat diakses dan catat demo mana yang tidak berhasil dibuka.

## 5. Rencana Aset 3D dan Lisensi

### 5.1 Sumber zombie utama — prioritas pertama

**Quaternius — Zombie Apocalypse Kit**  
https://quaternius.com/packs/zombieapocalypsekit.html

Halaman sumber menyebutkan paket berlisensi CC0, format termasuk glTF, sekitar 60 model, empat karakter playable, sekitar 20 animasi per karakter, empat enemy, dua anjing, serta aset lingkungan/kendaraan; paket dinyatakan dapat dipakai untuk proyek pribadi dan komersial. Tetap cek kembali file unduhan dan halaman lisensi saat digunakan.

Tugas agent:

1. Buka halaman sumber dan unduh paket dari sumber resmi bila kemampuan lingkungan mengizinkan.
2. Inspeksi isi ZIP dan pilih file glTF/GLB, bukan memasukkan semua file format mentah tanpa kebutuhan.
3. Identifikasi model enemy yang paling cocok untuk zombie dan periksa klip animasi yang benar-benar tersedia.
4. Uji satu model di scene diagnostik sebelum menggunakannya di level utama: skala, orientasi, material, tekstur, rig, bounding box, dan animasi.
5. Jika link download tidak bisa diakses otomatis, **jangan mengarang bahwa aset sudah berhasil diunduh**. Catat tautan, nama file yang diharapkan, lokasi tujuan, dan langkah manual yang harus dilakukan developer.
6. Jangan memasang aset dari URL remote langsung saat runtime. Simpan file yang dipakai secara lokal di `public/assets/` agar game tidak bergantung pada server pihak ketiga.

### 5.2 Senjata

**Quaternius — Ultimate Guns Pack**  
https://quaternius.com/packs/ultimategun.html

Halaman sumber mencantumkan 40 model senjata dan CC0, tetapi format yang tercantum adalah FBX/OBJ/Blend; jangan mengasumsikan ada glTF di paket ini. Jika dipilih, konversi/ekspor ke GLB perlu diuji. Jika tool konversi tidak tersedia, gunakan model senjata placeholder buatan sendiri yang bersih dan tandai sebagai placeholder sampai model final tersedia.

### 5.3 Aset lingkungan

- Prioritaskan aset lingkungan/kendaraan dari Zombie Apocalypse Kit.
- Aset tambahan hanya boleh ditambahkan setelah kualitas, format, ukuran, dan lisensinya diverifikasi.
- Sketchfab: https://sketchfab.com/ — cek halaman model individual serta lisensinya; jangan menganggap semua model Sketchfab gratis untuk penggunaan komersial. Hindari lisensi editorial untuk game komersial.
- Referensi ketentuan Sketchfab: https://sketchfab.com/licenses

### 5.4 Animasi tambahan / alternatif

- Mixamo: https://www.mixamo.com/ dapat dipertimbangkan untuk animasi humanoid tambahan, tetapi agent harus memverifikasi rig, format unduhan, dan ketentuan penggunaan dari sumber resmi saat memilihnya.
- Jangan menganggap animasi humanoid bisa langsung dipasang ke rig zombie apa pun. Periksa kompatibilitas skeleton/retargeting, root motion, orientasi, dan skala.

### 5.5 Struktur dan inventaris aset

Simpan aset terpilih dengan struktur yang mudah dipahami, misalnya:

```text
public/
  assets/
    characters/
      zombies/
    weapons/
    environment/
    vehicles/
    audio/
    textures/
```

Buat `ASSET_CREDITS.md` yang mencatat untuk **setiap** aset eksternal:

- nama aset/paket dan nama pembuat;
- URL sumber langsung;
- lisensi yang diperiksa;
- tanggal diunduh/diperiksa;
- nama file yang dipakai;
- apakah aset dimodifikasi/dioptimasi;
- atribusi wajib, bila ada.

Jangan memasukkan file besar atau aset yang tidak dipakai. Jangan memindahkan, mengubah, atau menghapus file aset sumber hingga tahu konsekuensinya. Asset license metadata harus ikut terpelihara saat proyek dipindahkan.

## 6. Gameplay Detail

### 6.1 Kontrol default

| Input | Aksi |
|---|---|
| WASD | Bergerak |
| Mouse | Melihat/mengarah |
| Shift | Sprint |
| Left click | Menembak |
| R | Reload |
| 1 / 2 | Memilih senjata, jika dua senjata sudah tersedia |
| Esc | Pause / melepas pointer lock |
| E | Interaksi sederhana, jika ada objek interaktif |

Tampilkan kontrol pada layar title/instruksi. Klik tombol Start harus meminta pointer lock secara eksplisit. Jika pointer lock ditolak browser, tampilkan instruksi pemulihan; jangan membiarkan kontrol mati tanpa penjelasan.

### 6.2 Player

- First-person camera dengan mouse look yang halus dan sensitivitas wajar.
- Gerak WASD relatif terhadap arah kamera, collision agar tidak menembus bangunan/prop utama, sprint dengan stamina opsional jika implementasinya stabil.
- Health mulai 100; damage masuk saat zombie sukses menyerang dalam jarak yang valid.
- Death state menghentikan gameplay, menampilkan hasil, dan menyediakan Restart.
- Weapon view model melekat pada kamera dan tidak menembus dinding secara berlebihan.
- Tidak boleh memproses tembakan saat game pause/game over.

### 6.3 Combat / senjata

- MVP: pistol dan assault rifle; jika dua senjata membuat pekerjaan melambat, sempurnakan satu senjata terlebih dahulu dan baru menambahkan yang kedua.
- Hitscan via raycast dari pusat crosshair/kamera; jelaskan hitbox dan jarak maksimum.
- Peluru, fire rate, magazine, reserve ammo, reload, recoil ringan, muzzle flash/impact feedback, audio, dan crosshair.
- Headshot multiplier hanya jika hitbox kepala bisa dipisahkan dengan cukup andal. Jangan pura-pura mendukung headshot bila setiap zombie hanya memiliki satu hitbox.
- Damage/HP/weapon stats harus berada di konfigurasi/data, bukan tersebar sebagai angka ajaib di banyak file.
- Ada jeda fire rate dan ammo check agar menahan klik tidak menembak tanpa batas.

### 6.4 Tipe zombie

Semua nilai adalah titik awal tuning, bukan angka final. Simpan dalam konfigurasi yang dapat diubah.

| Jenis | Perilaku | Keunggulan | Kelemahan |
|---|---|---|---|
| Walker | Berjalan ke pemain, menyerang dari jarak dekat | Jumlah banyak, ancaman standar | Lambat, HP rendah/sedang |
| Runner | Berlari saat melihat/mendengar pemain | Cepat, dapat mengepung | HP rendah |
| Tank | Bergerak lambat, serangan kuat, lebih banyak HP | Memaksa pemain mengatur jarak dan amunisi | Mudah dihindari, spawn terbatas |

Jangan labeli musuh sebagai special infected yang disalin dari Left 4 Dead. Buat karakter dan nama original jika tipe spesial ditambahkan nanti.

### 6.5 AI/state machine

Implementasikan state machine eksplisit, bukan kumpulan kondisi bertumpuk tanpa struktur:

- `SPAWN`: masuk level, pilih titik spawn aman dari pandangan langsung pemain.
- `IDLE/WANDER`: gerakan lokal atau diam saat belum mendapat target.
- `CHASE`: menuju posisi pemain memakai grid-based A* atau pathfinding ringan yang teruji.
- `ATTACK`: jika di dalam jarak dan cooldown serangan selesai, berikan damage satu kali per serangan.
- `HIT`: mainkan hit reaction jika tersedia; jangan memulai ulang animasi setiap frame.
- `DEATH`: matikan collision serangan, hentikan AI, mainkan animasi kematian, lalu bersihkan object/resources setelah durasi yang masuk akal.
- `DESPAWN`: hapus entity jauh atau selesai, tanpa meninggalkan listener, timer, geometri, atau referensi aktif.

Persyaratan navigasi:

- Zombie tidak boleh langsung berjalan melewati gedung, pagar solid, atau kendaraan utama.
- Buat collision map/nav grid yang selaras dengan level; dokumentasikan ukuran sel.
- Recalculate path dengan throttle ketika pemain berpindah cukup jauh atau rute buntu; jangan menjalankan A* untuk setiap zombie setiap frame.
- Tambahkan separation/steering ringan supaya zombie tidak semuanya menumpuk pada titik yang persis sama.
- Saat jalur diblokir, zombie harus memilih rute alternatif atau mereset path; jangan macet selamanya.
- Tangani target hilang, entity mati, dan level restart dengan aman.

### 6.6 Horde, wave, dan scaling

- Mulai dari 10–20 zombie aktif, lalu naikkan kapasitas setelah profiling.
- Wave berikutnya muncul setelah kondisi clear/timeout yang didefinisikan dengan jelas; jumlah zombie dan komposisi meningkat bertahap.
- Spawn menghindari area terlalu dekat/di depan kamera pemain, dan memberi feedback audio/UI bila diperlukan.
- Gunakan object pooling untuk proyektil/efek/entity bila pengukuran menunjukkan alokasi berulang menjadi beban.
- Target awal adalah 20–30 zombie beranimasi aktif pada desktop yang wajar, bukan janji semua perangkat mencapai 60 FPS.
- Fitur 50–100+ zombie visual dapat menjadi eksperimen lanjutan menggunakan LOD, update AI bertahap, proxy jauh, atau impostor. Ukur hasilnya dan jangan mengasumsikan semua rig skeletal dapat digabungkan ke satu `InstancedMesh` biasa.
- `InstancedMesh` cocok untuk props statis berulang seperti puing, lampu, atau barikade serupa. Karakter skeletal beranimasi butuh strategi khusus; jangan menggunakan instancing biasa secara keliru untuk animasi skeletal independen.
- Zombie memanjat tumpukan/barikade ala horde WWZ adalah fase lanjutan. MVP cukup membuat gerombolan mengelilingi obstacle dan mengejar lewat jalur yang valid.

### 6.7 Level dan art direction

- Satu kota kecil saat senja/malam dengan pencahayaan kontras dan visibilitas pertempuran tetap memadai.
- Rute memiliki ruang lebar untuk pertempuran dan jalur samping untuk flank.
- Bangunan memberi batas level yang jelas; hindari area kosong tanpa skala.
- Props: mobil terbengkalai, pagar, barikade, kontainer/sampah, lampu jalan, rambu original, pecahan kaca/puing jika tersedia.
- Utamakan siluet dan kontras karakter dengan latar. Zombie tidak boleh sama warnanya dengan background hingga sulit dibaca.
- Hindari post-processing mahal sebagai default. Tambahkan efek sinematik satu per satu dan sediakan preset kualitas rendah.
- Jika aset eksternal belum tersedia, blockout boleh menggunakan geometri procedural sementara. Tandai jelas sebagai **placeholder**, jangan klaim aset final sudah terpasang.

### 6.8 UI/UX

- Title screen dengan tombol Start, Controls, Settings, dan Credits.
- HUD minimal: health, crosshair, weapon, ammo, kills, wave, prompt reload, hit/damage feedback.
- Pause menu: Resume, Restart, Settings, Exit to Title.
- Game over: sebab/status sederhana, kill count, wave tertinggi, Restart.
- Settings: master volume, sensitivity, kualitas grafis atau shadow toggle, dan opsi mengurangi efek flash jika efek tersebut ada.
- Input UI jangan mengirim tembakan atau gerakan saat pointer berada pada kontrol menu.
- Tampilkan loading state dan pesan error yang bisa ditindaklanjuti jika asset gagal dimuat.

## 7. Arsitektur dan Organisasi Kode

Sesuaikan dengan repository yang ditemukan; ini target struktur, bukan alasan untuk mengganti kode yang sudah baik tanpa perlu.

```text
src/
  main.ts
  app/
    Game.ts
    gameConfig.ts
  core/
    GameLoop.ts
    EventBus.ts
    AssetManager.ts
    Disposable.ts
  engine/
    Renderer.ts
    SceneSetup.ts
    Lighting.ts
  input/
    InputManager.ts
    PointerLockController.ts
  player/
    PlayerController.ts
    PlayerHealth.ts
    WeaponController.ts
  combat/
    HitscanWeapon.ts
    DamageSystem.ts
  zombies/
    Zombie.ts
    ZombieFactory.ts
    ZombieAI.ts
    ZombieAnimator.ts
    ZombieDirector.ts
    NavigationGrid.ts
    pathfinding.ts
  level/
    CityLevel.ts
    CollisionWorld.ts
    SpawnPoints.ts
  systems/
    WaveManager.ts
    PickupManager.ts
    AudioManager.ts
  ui/
    HUD.ts
    Menus.ts
    Settings.ts
  utils/
    disposeObject3D.ts
    math.ts
  styles/
    main.css
  tests/
    ...
public/
  assets/
    ...
```

Prinsip desain:

- Pisahkan rendering, input, AI, damage/combat, wave, audio, dan UI. Gunakan fungsi/class kecil yang punya tanggung jawab jelas.
- Jangan membuat seluruh game dalam satu `main.ts` besar.
- Hindari circular dependency; gunakan interface/event bila diperlukan.
- Game loop memakai delta time yang dibatasi agar tidak meledak setelah tab kembali aktif. Sistem AI boleh memakai fixed/update interval terpisah bila perlu.
- Batasi alokasi objek di loop per frame. Reuse `Vector3`, raycaster, matriks, dan scratch objects saat masuk akal.
- Semua aset di-preload atau dimuat dengan status loading; penanganan error harus nyata.
- Gunakan satu sumber kebenaran untuk state pause/game over agar input, audio, update AI, dan HUD sinkron.
- Bersihkan listener, timers, animation mixers, geometries, materials, textures, dan audio resources saat restart/meninggalkan level.

## 8. Performa, Kualitas, dan Observability

- Profilkan sesudah gameplay inti bekerja; jangan optimasi buta sebelum ada pengukuran.
- Gunakan frustum culling default Three.js dengan benar; kurangi shadow-casting light dan jumlah lampu dinamis.
- Gunakan shared material/geometry untuk props serupa serta `InstancedMesh` untuk objek statis yang benar-benar berbagi geometry/material.
- Load hanya aset yang diperlukan; ukur total ukuran model/tekstur. Jangan mengirim semua format sumber dalam folder public.
- Hindari mencari path A* setiap frame per musuh. Gunakan cadence/threshold.
- AI off-screen/far boleh di-update lebih jarang dengan batas jarak yang jelas.
- Tambahkan debug mode opsional: FPS/frame timing, jumlah entity aktif, state zombie, nav grid/path, dan hitbox/collision toggle.
- Catat browser, hardware (jika diketahui), jumlah zombie, dan FPS perkiraan saat mengklaim performa. Jangan menyebut angka benchmark tanpa benar-benar mengukurnya.
- Tangani WebGL2 tidak tersedia dengan pesan yang jelas, bukan layar kosong tanpa diagnosis.

## 9. Milestone Implementasi

Kerjakan bertahap. Setiap milestone harus dapat dijalankan sebelum lanjut.

### M0 — Audit repository dan rencana

- Periksa repository saat ini sebelum membuat/mengubah file.
- Buat rencana berdasarkan kondisi repo; pertahankan pekerjaan pengguna yang ada.
- Setup Vite + TypeScript + Three.js hanya bila stack belum ada.
- Periksa sumber aset dan lisensi. Buat `ASSET_CREDITS.md`.
- Pastikan dev server dan production build awal berhasil.

### M1 — Playable graybox

- Renderer, scene, camera, lighting, ground, perimeter, beberapa obstacle.
- FPS controller, pointer lock, collision sederhana, pause.
- HUD minimum dan error/loading state.
- Gunakan geometry sementara hanya selama asset integration belum siap.

### M2 — Satu zombie animasi + combat

- Muat model dari Quaternius (atau alternatif yang lisensinya sudah diverifikasi).
- Buat diagnostic view/log untuk daftar klip animasi dan bounds model.
- Zombie mengejar melalui obstacle dan menyerang pemain.
- Implementasi satu senjata hitscan, ammo, reload, damage, death, dan restart.
- Tidak boleh lanjut ke banyak zombie jika satu zombie masih menembus obstacle, animasi salah, atau damage bug.

### M3 — Variasi musuh dan wave

- Tambahkan Walker/Runner/Tank berbasis konfigurasi.
- Wave/spawn director, medkit dan ammo pickup.
- Menu, pause, game over, audio settings, weapon switch jika sudah stabil.

### M4 — Visual/polish

- Perkaya kota menggunakan aset berlisensi jelas.
- Lighting, material, decals/efek ringan, sound, zombie variety.
- Polish reticle, damage feedback, weapon view model dan animation transitions.

### M5 — QA dan performance pass

- Jalankan typecheck, tests, build.
- Uji semua kontrol dan state menu.
- Periksa console, request asset 404, restart leaks, collision, nav dan performance.
- Tuning jumlah zombie berdasarkan hasil profiling aktual.
- Perbarui README dan daftar known limitations.

## 10. Kriteria Penerimaan MVP

MVP belum dianggap selesai kecuali semua yang dapat diuji di bawah ini lulus atau keterbatasannya tertulis jelas:

- `npm install` selesai tanpa error.
- `npm run dev` membuka game; README menyebut URL lokal bawaan.
- `npm run typecheck` lulus.
- `npm run test` lulus untuk test yang tersedia.
- `npm run build` lulus.
- Pemain dapat memulai, bergerak, melihat, menembak, reload, pause, resume, mati, dan restart.
- Input game tidak tetap aktif di belakang menu/pause/game over.
- Zombie eksternal berhasil muncul dengan skala/orientasi/material yang benar, memainkan klip yang sesuai, mengejar dan menyerang pemain, menerima hit, mati dan dibersihkan.
- Zombie tidak menembus bangunan besar utama; kasus nav buntu ditangani.
- Health, ammo, kills dan wave konsisten dengan gameplay.
- Tidak ada error console fatal atau request aset yang gagal tanpa pesan fallback.
- Aset eksternal yang digunakan memiliki catatan lisensi/sumber.
- Tidak ada klaim bahwa horde panjat, ragdoll, multiplayer, atau 100+ AI telah selesai kecuali benar-benar telah diimplementasikan dan diuji.

## 11. Instruksi Implementasi untuk AI Agent

Baca `agents.md` sebelum mengubah kode. Implementasikan game secara end-to-end, bukan hanya menulis rencana atau membuat mockup UI. Mulai dengan memeriksa repository dan menulis rencana ringkas. Lanjutkan ke milestone terkecil yang bisa dimainkan; jalankan validasi setelah setiap milestone. Bila satu detail aset tidak dapat diunduh atau lisensinya tidak jelas, pilih fallback yang aman dan jelaskan secara spesifik—jangan mengarang status unduhan atau menutupi blocker. Utamakan game yang benar-benar bisa dimainkan, struktur maintainable, aset legal, dan performa terukur dibanding daftar fitur besar yang hanya setengah bekerja.
