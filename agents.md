# AGENTS.md — Aturan Kerja AI Coding Agent

> Dokumen ini mengatur cara agent bekerja pada proyek game Three.js. `prd.md` adalah sumber kebenaran untuk fitur/produk; file ini adalah sumber kebenaran untuk perilaku, batasan, kualitas, dan cara kerja agent. Baca keduanya sebelum mengedit.

## 1. Perintah Utama

1. **Periksa sebelum mengubah.** Inspeksi struktur repo, package scripts, dependency, kode, asset, status Git, README, dan test yang sudah ada. Jangan menganggap proyek masih kosong.
2. **Patuhi `prd.md`.** Bila ada konflik, jelaskan konflik dan pilih keputusan paling konservatif agar proyek yang sudah bekerja tidak rusak.
3. **Kerjakan fitur end-to-end.** Fitur belum selesai hanya karena file/type/interface dibuat. Hubungkan input, update logic, rendering, UI, error handling, dan test yang relevan.
4. **Implementasikan bertahap.** Fokus pada satu vertical slice yang playable; jangan membuat semua sistem besar sekaligus tanpa validasi.
5. **Jujur tentang hasil.** Jangan bilang build/test/asset download berhasil sebelum benar-benar menjalankan atau memverifikasinya. Laporkan perintah yang gagal dan alasannya.
6. **Jangan menunggu instruksi untuk keputusan kecil yang sudah dijawab dokumen.** Pilih default yang sudah ditetapkan PRD; catat asumsi signifikan.
7. **Jangan berhenti di analisis.** Setelah rencana awal yang ringkas, langsung implementasikan pekerjaan yang bisa diselesaikan di lingkungan tersedia.

## 2. Yang Tidak Boleh Dilakukan

- Jangan menyalin game, kode, level, UI, audio, karakter, nama khusus, atau aset milik *World War Z*, *Left 4 Dead 2*, atau game komersial lain. Genre boleh menjadi inspirasi; semua identitas dan konten proyek harus original atau berlisensi sah.
- Jangan mengambil asset dari demo/browser game lain hanya karena bisa diunduh. Demo adalah referensi perilaku dan pembelajaran kecuali lisensi masing-masing aset/kode secara eksplisit mengizinkan reuse.
- Jangan memakai aset Sketchfab, Mixamo, musik, texture, sound effect, font, atau file eksternal tanpa memeriksa syarat penggunaan pada sumber resminya.
- Jangan mengklaim sebuah aset CC0, komersial, atau bebas atribusi berdasarkan nama situs saja. Periksa halaman paket/model individual dan catat hasilnya.
- Jangan meng-hotlink file model/texture/audio pihak ketiga di runtime. Gunakan salinan lokal yang lisensinya jelas.
- Jangan mengarang file yang telah diunduh, klip animasi yang tersedia, hasil benchmarking, atau hasil test.
- Jangan meninggalkan cube/kapsul sebagai zombie final. Geometri primitif diperbolehkan sebagai blockout/fallback yang diberi label eksplisit, tetapi integrasi model 3D dan animasi adalah requirement PRD.
- Jangan mengandalkan placeholder atau mock UI untuk mengaku fitur gameplay selesai.
- Jangan menambah framework/dependency besar tanpa kebutuhan jelas. Hindari React, state manager, backend, database, multiplayer networking, asset CDN runtime, atau physics engine jika tidak diperlukan oleh milestone saat ini.
- Jangan meletakkan seluruh logic di satu file atau membuat modul yang saling import melingkar.
- Jangan menggunakan `any` secara luas, mengabaikan TypeScript error, atau menyelesaikan type error dengan cast paksa yang menutupi bug.
- Jangan menggunakan `setInterval` tanpa lifecycle/cleanup untuk AI, spawn, atau combat. Jangan membuat timer/listener baru tiap frame.
- Jangan menggerakkan player/zombie dengan angka per frame tanpa delta time atau sistem update yang konsisten.
- Jangan menjalankan pathfinding setiap frame untuk setiap zombie.
- Jangan menggunakan `InstancedMesh` biasa seolah-olah ia otomatis mendukung skeleton/animasi independen untuk banyak `SkinnedMesh`. Pilih strategi crowd yang benar dan jelaskan trade-off-nya.
- Jangan menggabungkan file hasil unduhan sumber (FBX, OBJ, Blend, texture besar) ke folder publik jika tidak digunakan runtime.
- Jangan menyimpan secret, token, credential, atau API key. MVP tidak memerlukan API key.
- Jangan menonaktifkan test, menghapus test yang gagal, menekan error console secara umum, atau mengubah script agar selalu mengembalikan sukses.
- Jangan menimpa/menghapus pekerjaan pengguna, lockfile, konfigurasi, asset atau file existing tanpa memahami alasan dan dampaknya.
- Jangan menyatakan dukungan mobile, multiplayer, horde 100+, panjat-tumpukan, ragdoll, atau fitur lain sebelum benar-benar diimplementasikan dan diuji.

## 3. Workflow Wajib

### Sebelum coding

1. Baca `prd.md`, `agents.md`, `README.md`, `package.json`, struktur `src/` dan `public/`, test, dan daftar asset.
2. Jika Git tersedia, periksa `git status`. Jangan menghapus perubahan lokal yang belum di-commit.
3. Tulis rencana singkat 3–7 langkah yang merujuk pada milestone PRD.
4. Kenali script yang tersedia. Jika tidak ada, tambahkan script minimal tanpa menghapus script existing.
5. Verifikasi URL dan lisensi aset dari sumber resmi. Jangan mengasumsikan koneksi internet tersedia.

### Saat coding

1. Bangun smallest complete vertical slice. Contoh: player move → satu zombie muncul → AI chase → hit damage → death/restart.
2. Jaga perubahan tetap scoped. Hindari refactor seluruh proyek sebagai efek samping fitur kecil.
3. Buat konfigurasi untuk balance values (HP, speed, damage, fire rate, ammo, spawn limits) agar mudah dituning.
4. Gunakan TypeScript strict dan interface/type yang eksplisit untuk entity, weapon config, game state, asset manifest, dan event penting.
5. Tangani loading/error state nyata untuk aset. Satu model gagal dimuat tidak boleh menghasilkan layar kosong tanpa diagnosis.
6. Pisahkan simulasi/gameplay dari visual presentation sejauh masuk akal, supaya pathfinding, damage, wave dan state machine bisa diuji tanpa renderer.
7. Update docs dan `ASSET_CREDITS.md` bersamaan dengan perubahan terkait aset/struktur.
8. Setelah perubahan besar, jalankan validasi. Jangan menumpuk banyak perubahan sebelum menjalankan build.

### Setelah coding

Jalankan perintah yang tersedia (tambahkan bila perlu):

```bash
npm run typecheck
npm run test
npm run build
```

Jika browser automation tersedia, lakukan smoke test untuk start, pointer lock/input, tembakan, damage, pause, death, restart, dan error/asset loading. Jika tidak dapat dilakukan karena akses browser atau WebGL tidak tersedia, tulis keterbatasannya dengan jelas.

Lalu:

- cek console error dan request 404;
- cek model skala, rotasi, posisi kaki/ground, animasi serta bounds;
- pastikan pause/game over menghentikan input, AI, damage, dan tembakan;
- cek restart tidak menggandakan listener, timer, entity, audio atau scene object;
- cek `git diff` untuk perubahan tak disengaja;
- update README dengan cara install/run, kontrol, aset, dan batasan yang diketahui;
- laporkan ringkas file utama yang berubah, validasi yang dijalankan, hasilnya, dan pekerjaan yang belum selesai.

Jangan menyembunyikan kegagalan command. Jika sebuah script tidak ada, laporkan dan/atau tambahkan script yang sesuai.

## 4. Aturan Aset dan Lisensi

### Sumber prioritas

1. **Zombie Apocalypse Kit — Quaternius:** https://quaternius.com/packs/zombieapocalypsekit.html  
   Sumber utama kandidat zombie, animasi, kendaraan, dan environment. Halaman menyatakan CC0 dan menyediakan format termasuk glTF. Validasi kembali lisensi/file yang benar saat unduhan.
2. **Ultimate Guns Pack — Quaternius:** https://quaternius.com/packs/ultimategun.html  
   Kandidat weapon mesh; halaman menyebut CC0, tetapi format yang tercantum FBX/OBJ/Blend, bukan glTF. Jangan anggap file GLB tersedia; konversi harus diuji bila diperlukan.
3. **Mixamo:** https://www.mixamo.com/  
   Fallback animasi humanoid. Periksa penggunaan, format, dan kompatibilitas rig dari sumber resmi sebelum dipakai.
4. **Sketchfab:** https://sketchfab.com/ serta https://sketchfab.com/licenses  
   Gunakan hanya aset dengan lisensi individual yang cocok untuk tujuan proyek. Jangan gunakan lisensi editorial untuk game komersial.

### Format aset runtime (wajib)

- **Gunakan glTF 2.0 (`.glb` atau `.gltf`) sebagai format runtime untuk seluruh model 3D**—karakter, zombie, senjata, kendaraan, dan lingkungan. `.glb` disarankan bila model beserta material/teksturnya dapat disimpan dalam satu berkas.
- FBX boleh dipakai hanya sebagai berkas sumber/intermediate untuk konversi; jangan memuat atau mengirim FBX sebagai aset runtime.
- Bila aset resmi hanya tersedia sebagai FBX, konversikan ke glTF dengan tool yang sesuai. Verifikasi hasil konversi di scene diagnostik: skala/orientasi, material dan tekstur, skeleton, seluruh klip animasi, root motion, serta ukuran file. Jangan menganggap konversi berhasil hanya karena berkas output tercipta.
- Jika konversi atau validasi gagal, jangan diam-diam mempertahankan FBX runtime. Catat blocker dan aset terdampak, cari alternatif berlisensi yang menyediakan glTF, atau minta keputusan eksplisit sebelum membuat pengecualian. Pengecualian harus dibatasi pada aset yang disebutkan, diberi alasan, dan dicatat di `ASSET_CREDITS.md` serta known limitations.
- Perbarui loader, manifest aset, tes, README, dan `ASSET_CREDITS.md` sesuai format akhir yang benar-benar dipakai. Jangan menyatakan proyek sudah memenuhi kebijakan glTF jika masih ada FBX yang dimuat saat runtime.

### Proses verifikasi aset

Untuk setiap kandidat asset:

1. Catat URL sumber, nama creator, title, format, lisensi, dan tanggal pemeriksaan.
2. Unduh hanya dari sumber resmi/author atau jalur unduh sah yang ditawarkan.
3. Periksa arsip sebelum ekstraksi; jangan menjalankan executable atau script yang tidak diperlukan dari paket aset.
4. Ekstrak hanya aset yang akan digunakan.
5. Simpan aset runtime secara lokal di `public/assets/`.
6. Buka/load file melalui aplikasi atau diagnostic scene; periksa mesh, material, tekstur, orientasi, scale, skeleton, klip animasi, dan ukuran file.
7. Tambahkan sumber dan lisensi ke `ASSET_CREDITS.md`.
8. Jika hak pakai atau sumber file tidak jelas, **jangan gunakan aset tersebut**. Cari pengganti atau gunakan procedural placeholder sampai keputusan sah tersedia.

### Animasi karakter

- Jangan berasumsi nama klip. Iterasi semua `AnimationClip` dan log nama/durasi pada mode development.
- Buat mapping klip toleran huruf besar/kecil, misalnya kandidat `idle`, `walk`, `run`, `attack`, `hit`, `death`, tetapi validasi hasilnya saat runtime.
- Bila klip tidak ada, pilih fallback paling aman (misalnya `walk` untuk chase lambat) dan catat kekurangannya. Jangan memutar `death` berulang atau mengembalikan zombie mati ke state hidup secara tidak sengaja.
- `AnimationMixer.update(delta)` dipanggil dengan lifecycle yang jelas. Hentikan action dan lepaskan mixer saat entity dibersihkan.
- Jika retargeting diperlukan, dokumentasikan skeleton source dan target serta lakukan uji visual untuk kaki meluncur, arah hadap, dan root motion.

## 5. Aturan Arsitektur

- `main.ts` hanya bootstrap aplikasi, bukan rumah bagi seluruh sistem.
- Renderer/Three.js tidak boleh menjadi sumber kebenaran semua gameplay logic.
- Gunakan satu sumber kebenaran untuk `playing`, `paused`, `gameOver`, dan `loading` agar sistem input/AI/UI/audio sinkron.
- Pisahkan AI, nav/pathfinding, damage, weapon, wave/spawn director, input, audio, UI, asset loading, dan scene.
- Gunakan event/type atau API yang jelas untuk komunikasi modul, bukan circular imports.
- Jangan membuat banyak manager global yang tidak terukur. Sediakan ownership/lifecycle pada object dan subsystem.
- Game loop harus menangani delta time besar setelah tab tidak aktif; clamp delta atau gunakan fixed-step accumulator untuk simulasi yang membutuhkannya.
- Batasi object allocation per frame. Reuse vectors/matrices/raycasters jika sesuai tanpa mengorbankan keterbacaan.
- Semua listener/timer harus bisa dilepas. Restart harus mengembalikan game ke satu state bersih.
- Jangan memakai asset manager/abstraction generik yang terlalu kompleks untuk hanya satu asset. Bangun abstraksi hanya saat mengurangi duplikasi atau memecahkan kebutuhan nyata.

## 6. Aturan AI, Navigasi, dan Combat

- Representasikan zombie sebagai state machine eksplisit dan dapat diuji.
- Separasikan desired movement/steering dari render transform sejauh mungkin.
- Gunakan nav grid/A* atau sistem lain yang dijustifikasi; obstacle map harus sesuai dengan geometri collision.
- Throttle/reuse pathfinding, hindari semua zombie menghitung path dalam frame yang sama jika beban tinggi.
- Hindari serangan yang memberi damage tiap frame selama zombie berada di dekat player. Gunakan cooldown satu serangan/animasi yang konsisten.
- Ketika zombie mati, hentikan damage, AI, target selection, dan collision yang tidak diperlukan.
- Penembakan harus memakai hit detection nyata, bukan sekadar menurunkan HP zombie terdekat yang tidak terkena ray.
- Kalau headshot tidak didukung hitbox terpisah, jangan menampilkan headshot bonus.
- Data tuning ada di konfigurasi. Jangan menyebar angka magic ke seluruh modul.
- Gunakan seeded/random injectable generator jika test deterministik perlu mengontrol random spawn.

## 7. Aturan Performa dan Rendering

- Target performa harus diukur pada scene dan perangkat yang diketahui; jangan menjanjikan target universal.
- Mulai dengan batas zombie aktif yang rendah; tingkatkan setelah profiler menunjukkan ruang.
- Gunakan LOD/culling dan update cadence yang masuk akal; zombie jauh boleh disederhanakan atau update lebih jarang.
- Gunakan `InstancedMesh` untuk objek yang cocok berbagi geometry/material, terutama props statis. Jangan menggunakannya langsung untuk banyak skinned character independen tanpa strategi animasi crowd yang benar.
- Kurangi shadow-casting lights, texture resolution yang tidak perlu, draw calls, dan transparansi mahal.
- Hindari post-processing berat sampai kebutuhan dasar jelas. Sediakan low-quality option jika efek grafis ditambahkan.
- Buang geometry/material/texture ketika benar-benar tidak lagi digunakan dan tidak direferensikan oleh entity lain.
- Tambahkan debug overlay opsional untuk FPS, active zombies, path/state, dan collision. Debug tools harus bisa dimatikan.
- Jangan mematikan frustum culling secara global sebagai solusi mudah.

## 8. UI, Kontrol, dan Aksesibilitas

- Pointer lock diminta akibat tindakan klik user yang eksplisit; beri cara masuk kembali jika browser menolaknya.
- Pause/menu/game over menonaktifkan update gameplay sesuai definisi; jangan menembak atau menerima damage di belakang menu.
- Semua tombol perlu aksi yang benar-benar terhubung. Jangan buat button dekoratif yang seolah berfungsi.
- Kontrol dan indikator ammo/health harus terbaca; jangan menutupi crosshair/area pertempuran dengan panel besar.
- Semua audio tunduk pada volume/mute. Tangani kebijakan browser yang menunda AudioContext sampai interaksi pengguna.
- Jika ada flash/recoil/camera shake intens, sediakan opsi mematikan atau menguranginya.
- Tampilkan pesan loading/error aset yang spesifik dan bisa ditindaklanjuti.

## 9. Keamanan, Kebersihan Repo, dan Dependency

- Jangan menambah backend, API key, credential, telemetri, atau request pihak ketiga tanpa kebutuhan dan persetujuan yang jelas.
- Jangan memakai `eval`, dynamic code execution, atau mengunduh/menjalankan kode dari URL saat game berjalan.
- Jangan menonaktifkan CORS/security browser untuk mengatasi asset error. Perbaiki hosting/path asset.
- Hindari dependency dengan tujuan yang sama. Periksa ukuran, maintenance, lisensi, dan kompatibilitas sebelum menambah dependency.
- Simpan `package-lock.json`; jangan menghapus lockfile agar install “berhasil”.
- Pastikan `.gitignore` tidak mengabaikan source code, dokumen, atau file asset runtime yang diperlukan. Pertimbangkan ukuran binary sebelum commit.
- Jangan auto-format atau rewrite seluruh repository tanpa alasan. Ikuti style existing yang sehat.

## 10. Kualitas Test Minimum

Buat unit tests untuk logika yang tidak memerlukan WebGL:

- transisi state zombie;
- perhitungan damage/HP/death;
- ammo/fire rate/reload;
- cooldown attack agar satu serangan tidak memberi damage berkali-kali;
- spawn/wave progression dan batas maksimum active entity;
- pathfinding pada grid kosong dan saat ada obstacle;
- pause/game-over menghentikan simulasi;
- cleanup entity tidak meninggalkan zombie aktif dalam director.

Bila test otomatis browser tersedia, smoke-test:

1. game boot/loading dan pesan error;
2. Start/pointer lock/control;
3. gerakan dan collision;
4. tembakan/reload/damage;
5. zombie chase/nav/attack/death;
6. pause/resume;
7. game over/restart;
8. asset fetch tidak 404 dan tidak ada console error fatal.

Jangan menulis test yang sekadar menguji bahwa fungsi ada atau selalu mengembalikan true. Uji perilaku dan edge cases.

## 11. Definition of Done

Tugas selesai jika:

- perubahan sesuai milestone PRD dan game benar-benar dapat dijalankan;
- TypeScript check, unit tests, dan production build dijalankan dan hasilnya dilaporkan;
- fitur kritis diuji atau keterbatasan testing dijelaskan;
- tidak ada aset eksternal tanpa sumber/lisensi di `ASSET_CREDITS.md`;
- error penting diperbaiki atau didokumentasikan;
- README dan known limitations diperbarui;
- tidak ada placeholder yang dipresentasikan sebagai fitur final;
- perubahan repo terarah dan tidak menghapus pekerjaan existing.

## 12. Format Laporan Akhir Agent

Saat menyelesaikan satu pekerjaan, jawab dengan format:

1. **Yang selesai:** daftar fitur yang benar-benar sudah bekerja.
2. **File utama berubah:** nama file dan tanggung jawabnya.
3. **Asset/lisensi:** apa yang dipakai, sumber, dan apa yang belum tersedia.
4. **Validasi:** command yang dijalankan dan hasil aktual (`PASS`/`FAIL`/`NOT RUN`).
5. **Yang belum selesai/risiko:** blocker, fallback, edge case, atau keterbatasan browser/asset.
6. **Cara menjalankan:** command konkret sesuai script repo.

Jangan sekadar menjawab “selesai” tanpa bukti validasi dan keterbatasan.

## 13. Aturan Verifikasi (meter, frame, build, commit)

Aturan di bagian ini lahir dari kegagalan nyata di proyek ini, bukan teori. Semuanya wajib.

### 13.1 Curigai alat ukur sebelum menyalahkan fitur

Di proyek ini sudah **lima kali** check yang gagal ternyata salahnya alat ukur, bukan kodenya.

- **Saring target sebelum memilih.** Setiap helper “terdekat” (`nearest`, `findClosest`, dsb.) WAJIB
  menyaring entitas yang mati/tidak aktif. Kasus nyata: harness melee memindahkan pemain ke **1,65 m
  dari MAYAT** yang masih ditahan director untuk animasi kematian, membaca sudut **0,2°** (terlihat
  sempurna), sementara satu-satunya zombie hidup ada di **20,8 m pada 126°** — di luar jangkauan. Hasil:
  0 damage, dan senjatanya yang dituduh.
- **Harness tidak boleh mencetak sukses tanpa membaca hasilnya sendiri.** Pola
  `await tungguBoot(); console.log('booted')` melaporkan boot bersih di port tanpa server, lalu mati
  90 detik kemudian di elemen `null` — yang terbaca persis seperti fitur rusak. Tangkap boolean-nya dan
  **lempar error** yang menyebut penyebabnya. Buktikan guard-nya menggigit dengan menembak URL yang
  termuat tapi tidak berisi game (path 404), **bukan** port mati (itu menghasilkan CDP timeout di jalur
  lain dan tidak membuktikan apa pun).
- **Kalibrasi bacaan sudut.** Kamera menghadap −Z sedangkan model menghadap +Z — selisih tetap 180°.
  Kalibrasi dulu terhadap kasus yang **sudah diketahui berhasil** (senjata yang memang mendarat), baru
  percaya angkanya. Sampai kalibrasi selesai, **damage adalah satu-satunya bukti yang sah**.

### 13.2 Setiap perubahan yang terlihat wajib satu frame yang benar-benar diperiksa

**Angka lolos bukan berarti ter-render.** Dua kali terjadi di proyek ini:

- LMG: `loadingFailures: []`, HUD `BELT-FED LMG 150/300`, flash 2, tracer 1, harness `WEAPONS_OK` —
  dan senjatanya **tidak tergambar sama sekali**. Hanya satu frame yang menemukannya.
- MP7: seluruh suite lulus (siluet piksel, frustum, mekanisme racks) — tapi garis bidiknya **paling
  rendah di roster** dan masuk ke dalam kotak tangan, sehingga receiver dan optic tidak terbaca.

Aturan: perubahan pada view model, senjata, efek, HUD, atau pencahayaan **wajib** disertai minimal satu
frame yang diambil dan **dibaca sendiri oleh agent** (bukan hanya “screenshot tersimpan”). Laporan
tanpa pemeriksaan gambar tidak diterima. Kalau tidak ada alat vision, katakan terus terang dan andalkan
metrik terukur (proyeksi NDC kotak dunia, luminance area senjata, jarak ujung laras ke kilatan).

### 13.3 Harness menyajikan `dist/`, bukan `src/`

Setelah mengubah sumber, frame akan menampilkan perilaku **lama** kalau `dist/` belum dibangun ulang —
dan agent bisa “memverifikasi” perbaikan yang tidak pernah masuk build. Urutannya wajib:
`npm run build` → restart server → `curl -s -o /dev/null -w '%{http_code}' <url>` harus **200** →
baru jalankan harness.

### 13.4 Host 2 GiB: kelola proses sebelum menjalankan browser

- Bunuh Chrome tersisa **dan** `tsserver`/`typingsInstaller` sebelum tiap run (keduanya respawn dan
  memegang memori yang membuat CDP timeout).
- **Satu Chrome** pada satu waktu; jangan menjalankan `full-check.sh` paralel.
- Periksa `/sys/fs/cgroup/memory.current` dan `memory.peak`. Job yang di-OOM-kill di plafon
  meninggalkan **log kosong** — itu bukan skrip rusak, itu kehabisan memori.

### 13.5 Commit saat ada penulis paralel

- Tambahkan **path eksplisit**, jangan `git add -A`, selama ada pekerja lain menulis.
- Tapi periksa arah sebaliknya: path eksplisit bisa **menelantarkan berkas selesai yang diimpor oleh
  commit itu sendiri** — pohon yang hijau di lokal dan rusak di clone baru. Setelah commit, selesaikan
  setiap impor relatif di berkas ter-commit dan pastikan targetnya juga ter-commit.
- **Satu penulis per berkas.** Patch yang gagal dengan “could not find old_string” di berkas milik
  pekerja lain adalah tanda pelanggaran kepemilikan, bukan bug yang harus dipaksa.

### 13.6 Turunkan angka, jangan pilih

Nilai yang dipilih “kira-kira pas” akan melenceng. Cari invarian yang **sudah berlaku** di kasus yang
bekerja, lalu selesaikan untuk kasus baru. Contoh nyata: `normalizeViewModel` memaksa sumbu terpanjang
setiap mesh menjadi 0,42 m, jadi panjang tergambar = 0,42 × scale dan ukuran tampak = panjang / kedalaman
— **scale dan kedalaman adalah satu keputusan**, bukan dua. Mengukur senjata yang sudah terbukti bagus
memberi konstanta keluarga 0,73 drawn-metre per real-metre, dan mengubah tiga tebakan menjadi tiga
turunan.

### 13.7 Buktikan tes baru bisa menggigit

Tes yang tidak bisa gagal hanyalah dekorasi. Mutasi nilai yang dijaganya (atau `git stash` perbaikannya)
dan pastikan ia gagal dengan pesan yang diharapkan, sebelum tes itu dianggap bukti.
