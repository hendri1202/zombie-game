# Rencana Implementasi — Misi Rumah Sakit Distrik

**Tanggal:** 2026-10-15  
**Proyek:** Dead District  
**Status:** Rencana saja — belum diimplementasikan  
**Tujuan:** Misi lanjutan setelah survival di ruas kota, berfokus pada eksplorasi dan pertempuran di dalam gedung.

## 1. Kondisi proyek dan batas rencana

Game saat ini sudah memiliki fondasi horde-survival yang playable: karakter survivor third-person (dengan opsi first-person), senjata hitscan dan reload, zombie beranimasi dengan AI/nav grid, wave, pickup, HUD/menu, serta kota blockout dengan bangunan yang masih berupa massa luar solid. Misi berurutan dengan objektif belum tampak sebagai sistem gameplay.

Rencana ini tidak menganggap semua isi `prd.md` sudah tuntas. Dokumen PRD utamanya mendefinisikan MVP survival satu blok kota; interior bangunan dan campaign/objective mission adalah perluasan setelah MVP. Sebelum fitur baru, jalankan kembali validasi karena pemeriksaan penuh terbaru yang dicoba untuk rencana ini berhenti pada timeout tool.

**Batasan teknis yang memengaruhi desain:** level sekarang datar, tidak ada gravitasi/lompatan/tangga, collision dan navigasi dibuat dari grid 2D, serta fasad bangunan menjadi collider kotak. Karena itu, gedung bertingkat yang benar-benar dapat dimainkan membutuhkan sistem lantai/nav/collision vertikal baru. Jangan sekadar membuat lubang di kotak collider atau tangga dekoratif lalu mengklaim lantai atas bisa dimainkan.

## 2. Konsep misi

### Nama kerja: "Sinyal Terakhir"

Pemain menerima sinyal radio lemah dari **Rumah Sakit Distrik Arunika**, sebuah fasilitas kecil-menengah yang menjadi titik evakuasi sebelum jaringan kota runtuh. Tujuan misi adalah menyalakan generator darurat, mengambil perangkat radio/daftar penyintas dari ruang administrasi, lalu keluar melalui loading bay sebelum suara generator menarik horde ke dalam.

Misi ini mengubah ritme permainan: bukan bertahan dalam wave terbuka tanpa tujuan, melainkan bergerak melalui ruang sempit, memilih jalur, mengelola amunisi, membuka akses, dan memutuskan kapan harus melawan atau menghindar. Semua nama, signage, layout, dan narasi adalah orisinal.

### Premis naratif singkat

> "Sinyalnya datang dari rumah sakit. Generatornya mati, pintu otomatis terkunci, dan baterai radio tinggal sedikit. Masuk, pulihkan daya, ambil catatan evakuasi, lalu keluar sebelum mereka semua mendengar kita."

Narasi disampaikan lewat radio, papan petunjuk, dan props lingkungan; tidak perlu cutscene atau dialog panjang.

## 3. Sasaran pengalaman

- Memperkenalkan interior dengan siluet dan navigasi yang tetap mudah dibaca dalam suasana gelap.
- Menghasilkan ketegangan dari suara, pintu, sudut mati, dan jalur alternatif—bukan sekadar menambah HP zombie.
- Memberi objektif konkret dengan indikator kemajuan, checkpoint ringan, dan kondisi menang/kalah.
- Memanfaatkan AI, senjata, pickup, survivor, serta UI yang sudah ada sebelum membuat subsistem baru besar.
- Menyelesaikan vertical slice yang dapat dimainkan pada **satu lantai** dahulu; lantai atas menjadi fase terpisah setelah navigasi multi-level terbukti.

## 4. Rancangan gedung

### Bentuk umum

Rumah sakit distrik 2 lantai dengan basement utilitas. Bentuk tapak kira-kira 44 m × 32 m; angka ini ukuran blockout awal dan perlu disesuaikan dengan skala kontrol aktual. Lantai publik berada di ground floor. Basemen dan lantai dua ditandai pada denah/narasi, tetapi tidak masuk playable slice pertama.

### Denah ground floor — vertical slice pertama

```text
                         UTARA
        ┌─────────────────────────────────────┐
        │ [Loading bay / Keluar]  [Gudang]    │
        │          │             └───┬────────│
        │ [Koridor servis] ─── [Ruang staf]  │
        │          │                 │        │
        │ [Farmasi] ───── [Atrium / Lobby]    │
        │          │         │       │        │
        │ [Klinik] ──── [Resepsionis] │        │
        │ Pintu masuk utama   [Keamanan]      │
        └─────────────────────────────────────┘
                         SELATAN
```

Diagram konseptual, bukan gambar berskala. Sediakan dua rute antara lobby dan loading bay:

- **Rute servis (lebih aman, lebih panjang):** klinik → koridor servis → ruang staf → gudang → loading bay. Pintu gudang perlu dibuka dari panel daya setelah generator hidup.
- **Rute atrium (lebih cepat, lebih berbahaya):** lobby → atrium → gudang/loading bay. Banyak garis pandang dan ruang untuk horde; menawarkan pickup opsional.

### Fungsi dan pengalaman tiap ruang

1. **Pintu masuk/resepsionis:** safe-ish start area untuk orientasi, radio pertama, peta dinding, dan tutorial singkat interaksi.
2. **Klinik:** jalur awal sempit dengan beberapa ruang pemeriksaan; memberi satu medkit opsional. Hindari spawn musuh tepat di belakang pemain.
3. **Farmasi:** ruang samping buntu dengan amunisi sebagai reward. Pintu/lemari terbuka sederhana, bukan inventory system baru.
4. **Lobby dan atrium:** ruang pusat untuk landmark, orientasi arah, dan encounter utama setelah daya dipulihkan. Atrium tetap satu lantai dalam slice awal; void lantai dua hanya visual.
5. **Keamanan:** ruang kecil berisi panel kontrol pintu serta petunjuk lokasi generator. Panel hanya aktif setelah interaksi sederhana.
6. **Koridor servis/ruang staf:** rute flank lebih redup dan sempit. Pintu ruang staf menjadi choke point yang dapat dibuka/tutup dengan interaksi.
7. **Gudang:** berisi generator portabel/tuas pemutus dan objective utama. Saat generator dinyalakan, lampu darurat hidup dan memicu gelombang masuk dari beberapa titik spawn yang sudah diuji.
8. **Loading bay:** ekstraksi final. Gerbang gulung baru dapat dibuka setelah perangkat/catatan evakuasi diambil. Zona keluar harus jelas secara visual dan HUD.

### Identitas visual dan keterbacaan

- Rumah sakit kota biasa yang ditinggalkan: cat hijau pucat/abu, signage arah buatan proyek, ranjang dorong, tirai, kursi tunggu, rak, troli, dan lampu darurat.
- Palet luar lebih dingin; ruang generator memakai aksen amber/merah. Gunakan pencahayaan untuk membimbing mata, tidak menggelapkan lorong sampai musuh tak terbaca.
- Landmark yang terlihat dari lobby: meja resepsionis, papan direktori, tanda EXIT, dan lampu darurat menuju koridor servis.
- Pintu yang dapat dibuka harus berbeda secara visual dari pintu dekoratif. Tampilkan prompt interaksi hanya saat pemain cukup dekat dan sedang bermain.
- Props eksternal baru memerlukan verifikasi lisensi/sumber dan entri `ASSET_CREDITS.md`. Blockout boleh memakai primitive berlabel placeholder.

## 5. Alur misi dan objektif

### Tahap 0 — Briefing di luar

- Radio memberi koordinat dan tujuan: pulihkan daya lalu temukan catatan evakuasi.
- Pemain mulai di luar pintu selatan; pintu depan terbuka.
- HUD menampilkan objektif pertama dan petunjuk tombol interaksi.

### Tahap 1 — Masuk dan cari akses servis

- Objektif: **Temukan akses ke ruang generator.**
- Pemain melewati resepsionis dan klinik atau mengecek farmasi untuk amunisi/medkit opsional.
- Di ruang keamanan, tekan panel/interaksi untuk membuka akses koridor servis. Pemain tetap bisa mencapai area utama tanpa mengambil loot opsional.
- Encounter ringan mengajarkan jarak serang dan penggunaan choke point.

### Tahap 2 — Pulihkan listrik

- Objektif: **Nyalakan generator cadangan.**
- Pemain mencapai gudang lewat jalur servis.
- Interaksi berlangsung singkat dan tidak memerlukan minigame kompleks untuk slice awal.
- Suara starter dan lampu yang menyala memberi cue bahwa horde bereaksi.
- Pintu servis ditahan/terkunci selama encounter pendek; jumlah zombie dibatasi memakai cap aktif yang sudah dimiliki game.

### Tahap 3 — Ambil bukti/arah evakuasi

- Objektif: **Ambil catatan evakuasi dari ruang staf.**
- Setelah listrik hidup, pintu ke ruang staf terbuka.
- Catatan menjelaskan bahwa jalur utama terhalang dan loading bay adalah satu-satunya ekstraksi yang dapat dibuka.
- Pilihan opsional: cari farmasi untuk resource sebelum keluar. Loot tidak wajib agar misi dapat diselesaikan.

### Tahap 4 — Ekstraksi

- Objektif: **Buka gerbang loading bay dan keluar.**
- Gerbang terbuka melalui satu interaksi; saat proses berjalan muncul tekanan terakhir dari atrium/koridor servis.
- Keluar dari zona ekstraksi memicu hasil misi: sukses, ringkasan kill/resource, dan tombol lanjut/ulang/kembali ke title.
- Untuk scope pertama, setelah misi tidak ada persistence/campaign save; progres hanya untuk sesi aktif.

### Kondisi gagal dan restart

- Pemain mati: gunakan game-over flow yang ada, tambahkan label misi dan tombol ulang misi.
- Jangan memberi fail state karena waktu habis pada versi awal. Timer dapat diuji di iterasi berikutnya bila memperbaiki ketegangan, bukan membuat pemain terburu-buru tanpa informasi.
- Restart membersihkan objective, pintu, pickup, spawn, dan state generator agar tidak ada state tertinggal.

## 6. Encounter dan pacing

- **Eksplorasi awal:** 2–4 Walker, ruang cukup untuk memahami layout.
- **Generator:** 1 gelombang pendek dengan Walker dan sedikit Runner bila model/AI tersedia; gunakan bunyi dan lampu sebagai telegraph sebelum spawn.
- **Ekstraksi:** komposisi lebih padat tetapi tetap di bawah cap kualitas aktif. Rute servis memberi cover/choke; atrium memberi ruang tembak namun banyak arah ancaman.
- Tank/Brute tidak wajib untuk misi pertama. Jika digunakan, satu saja sebagai ancaman lambat yang memberi waktu untuk mundur, bukan spawn mendadak di ruang sempit.
- Spawn tidak boleh muncul dalam garis pandang langsung, menimpa pemain, atau di ruang tanpa jalan keluar. Nav grid/collision harus diuji di pintu dan tikungan.
- Jangan mengunci semua pintu setelah pemain masuk; sediakan rute mundur/loop yang disengaja agar misi tidak terasa sebagai jebakan tanpa pilihan.

## 7. Tahapan implementasi yang disarankan

### Misi slice A — ground floor blockout dan objektif

1. Buat dokumen layout/koordinat dan daftar collision/doorway sebelum membuat art detail.
2. Rancang ulang `CityLevel` atau buat level misi modular agar gedung interior tidak tertutup collider satu kotak; jaga level survival yang ada tidak rusak.
3. Bangun lantai, dinding dengan bukaan pintu, koridor, kamar, loading bay, dan signage placeholder. Daftarkan collider identik untuk pemain, zombie, hitscan, dan nav grid.
4. Tambahkan interaksi `E` bertipe jelas dan objektif bertahap dengan HUD; pastikan menu/pause/game over mematikan interaksi.
5. Integrasikan generator, pintu, pickup, spawn-trigger dan exit sebagai state misi; semua state harus reset saat restart.
6. Buat test unit untuk transisi objective, pintu, trigger spawn sekali saja, kondisi extraction, dan reset.
7. Jalankan smoke test: rute utama, rute servis, tembakan tidak menembus dinding, zombie melewati pintu yang terbuka, pause/resume, mati/restart, serta kemenangan misi.
8. Baru sesudah slice playable, ganti props penting dengan aset legal dan polish pencahayaan/audio.

### Misi slice B — lantai atas/basement

Hanya mulai setelah slice A stabil. Tambahkan representasi lantai sebagai `floorId` atau node nav bertingkat dan portal tangga sebagai koneksi antar-floor. Pemain memerlukan perpindahan elevasi nyata (stair traversal/step movement); zombie pathfinding perlu memahami koneksi lantai yang sama. Uji collider, tembakan, spawn, kamera third-person, dan batas jatuh. Elevator boleh menjadi pintu terkunci/dekorasi pada versi ini, bukan lift palsu.

### Misi slice C — campaign/polish

Setelah satu misi lengkap dan restart aman: tambah penyimpanan progres sesi, briefing akhir, perpindahan ke level berikutnya, varian objective, audio naratif, serta setting aksesibilitas/efek. Tidak ada multiplayer atau backend dalam scope.

## 8. Risiko dan mitigasi

- **Nav grid 2D:** pintu, lorong sempit, dan dinding baru dapat membuat zombie macet. Mulai satu lantai, buat tes grid, dan verifikasi jalur fisik sama dengan collider.
- **Vertical movement belum ada:** jangan scope lantai atas untuk deliverable pertama; gunakan dekorasi/cerita sampai sistem floor navigation tersedia.
- **Kamera third-person:** ruang sempit bisa membuat kamera menembus dinding. Uji boom-camera occlusion sebelum layout dianggap final; first-person tetap opsi, bukan asumsi wajib.
- **Kegelapan:** pencahayaan atmosfer dapat menurunkan keterbacaan. Uji visual frame dan brightness per ruang pada quality low/medium.
- **Pengelolaan state:** misi harus membersihkan listener, timer, entity, trigger, object, dan resource ketika restart/exit.
- **Lingkup:** jangan sekaligus menambahkan inventory, puzzle kompleks, boss, cutscene, voice acting, dan multi-floor pathfinding.
- **Aset:** jangan mengklaim props rumah sakit final sebelum sumber dan lisensinya diperiksa; siapkan blockout placeholder yang eksplisit.

## 9. Kriteria penerimaan misi pertama

- Pemain dapat masuk dan menyelesaikan satu misi dari briefing sampai keluar.
- Setiap objektif muncul, berubah, dan hanya selesai setelah kondisi yang benar terjadi.
- Dua jalur yang direncanakan bisa ditempuh; loot opsional bukan blocker progress.
- Pintu mengontrol akses secara konsisten untuk pemain, zombie, peluru, dan nav.
- Zombie tidak menembus dinding, tidak menyerang melewati ruang tertutup, dan tidak macet permanen di pintu.
- Generator memicu encounter sekali, bukan setiap frame/interaksi berulang.
- HUD menjelaskan objektif dan prompt interaksi; pause mematikan seluruh simulasi misi.
- Misi bisa dimulai ulang dari state bersih setelah sukses maupun mati.
- Typecheck, unit tests, build, dan browser smoke test lulus; daftar aset/lisensi diperbarui.
- Batasan vertical slice (satu lantai, tanpa save campaign) disebutkan jelas.

## 10. Belum dikerjakan oleh dokumen ini

Ini adalah **rancangan**, bukan implementasi. Belum ada gedung yang bisa dimasuki, sistem objective mission, interaksi pintu/generator, misi campaign, basement/lantai dua yang playable, ataupun test khusus misi. Persetujuan dan implementasi dilakukan sebagai pekerjaan berikutnya, bertahap mengikuti agents.md dan PRD.
