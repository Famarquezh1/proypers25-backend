# Proypers25 - Diagnostico local de hardware (solo lectura)
# Ejecutar en PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\tools\diagnostico-pc.ps1
#
# Genera: diagnostico-pc.json y diagnostico-pc.txt en la carpeta actual.

$ErrorActionPreference = "SilentlyContinue"

function GB($bytes) {
    if ($null -eq $bytes) { return $null }
    return [math]::Round(($bytes / 1GB), 2)
}

function SafeCim($className) {
    try { return Get-CimInstance -ClassName $className -ErrorAction Stop } catch { return $null }
}

$cpu = SafeCim "Win32_Processor"
$computer = SafeCim "Win32_ComputerSystem"
$os = SafeCim "Win32_OperatingSystem"
$bios = SafeCim "Win32_BIOS"
$baseboard = SafeCim "Win32_BaseBoard"
$gpus = @(SafeCim "Win32_VideoController")
$physicalDisks = @(Get-PhysicalDisk)
$logicalDisks = @(SafeCim "Win32_LogicalDisk" | Where-Object { $_.DriveType -eq 3 })
$memoryModules = @(SafeCim "Win32_PhysicalMemory")

$cpuName = ($cpu | Select-Object -First 1).Name
$cpuCores = ($cpu | Measure-Object -Property NumberOfCores -Sum).Sum
$cpuThreads = ($cpu | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
$maxClock = ($cpu | Measure-Object -Property MaxClockSpeed -Maximum).Maximum

$ramTotalBytes = if ($computer.TotalPhysicalMemory) { [double]$computer.TotalPhysicalMemory } else { 0 }
$ramFreeBytes = if ($os.FreePhysicalMemory) { [double]$os.FreePhysicalMemory * 1KB } else { 0 }

$features = [ordered]@{}
try {
    $reg = Get-ItemProperty "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0"
    $features.RegistryIdentifier = $reg.Identifier
    $features.VendorIdentifier = $reg.VendorIdentifier
} catch {}

$cpuCaption = ""
try {
    $cpuCaption = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Caption)
} catch {}

# AVX/AVX2: Windows/WMI no entrega una bandera fiable directamente.
# Se deja como "indeterminado" salvo que el nombre de CPU permita inferencia posterior.
$features.AVX = "indeterminado_por_SO"
$features.AVX2 = "indeterminado_por_SO"

$temperature = $null
try {
    $temps = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature
    if ($temps) {
        $temperature = @($temps | ForEach-Object {
            [math]::Round(($_.CurrentTemperature / 10) - 273.15, 1)
        })
    }
} catch {}

$gpuInfo = @()
foreach ($gpu in $gpus) {
    if ($null -ne $gpu -and $gpu.Name) {
        $gpuInfo += [ordered]@{
            Name = $gpu.Name
            AdapterRAM_GB = if ($gpu.AdapterRAM) { GB([double]$gpu.AdapterRAM) } else { $null }
            DriverVersion = $gpu.DriverVersion
            VideoProcessor = $gpu.VideoProcessor
            CurrentHorizontalResolution = $gpu.CurrentHorizontalResolution
            CurrentVerticalResolution = $gpu.CurrentVerticalResolution
        }
    }
}

$diskInfo = @()
if ($physicalDisks.Count -gt 0) {
    foreach ($disk in $physicalDisks) {
        if ($null -ne $disk) {
            $diskInfo += [ordered]@{
                FriendlyName = $disk.FriendlyName
                MediaType = "$($disk.MediaType)"
                BusType = "$($disk.BusType)"
                Size_GB = GB([double]$disk.Size)
                HealthStatus = "$($disk.HealthStatus)"
                OperationalStatus = "$($disk.OperationalStatus)"
            }
        }
    }
} else {
    foreach ($disk in $logicalDisks) {
        if ($null -ne $disk) {
            $diskInfo += [ordered]@{
                Drive = $disk.DeviceID
                FileSystem = $disk.FileSystem
                Size_GB = GB([double]$disk.Size)
                Free_GB = GB([double]$disk.FreeSpace)
            }
        }
    }
}

$memoryInfo = @()
foreach ($m in $memoryModules) {
    if ($null -ne $m) {
        $memoryInfo += [ordered]@{
            Manufacturer = $m.Manufacturer
            PartNumber = if ($m.PartNumber) { $m.PartNumber.Trim() } else { $null }
            Capacity_GB = GB([double]$m.Capacity)
            Speed_MHz = $m.Speed
            ConfiguredClockSpeed_MHz = $m.ConfiguredClockSpeed
            BankLabel = $m.BankLabel
            DeviceLocator = $m.DeviceLocator
        }
    }
}

$report = [ordered]@{
    GeneratedAt = (Get-Date).ToString("o")
    Computer = [ordered]@{
        Manufacturer = $computer.Manufacturer
        Model = $computer.Model
        SystemType = $computer.SystemType
        PCSystemType = $computer.PCSystemType
    }
    CPU = [ordered]@{
        Name = $cpuName
        Caption = $cpuCaption
        PhysicalCores = $cpuCores
        LogicalProcessors = $cpuThreads
        MaxClockMHz = $maxClock
        Architecture = ($cpu | Select-Object -First 1).Architecture
        L2CacheKB = ($cpu | Measure-Object -Property L2CacheSize -Sum).Sum
        L3CacheKB = ($cpu | Measure-Object -Property L3CacheSize -Sum).Sum
        Features = $features
    }
    RAM = [ordered]@{
        Total_GB = GB($ramTotalBytes)
        FreeAtCapture_GB = GB($ramFreeBytes)
        Modules = $memoryInfo
    }
    GPU = $gpuInfo
    Disks = $diskInfo
    Motherboard = [ordered]@{
        Manufacturer = $baseboard.Manufacturer
        Product = $baseboard.Product
        Version = $baseboard.Version
    }
    BIOS = [ordered]@{
        Manufacturer = $bios.Manufacturer
        SMBIOSBIOSVersion = $bios.SMBIOSBIOSVersion
        ReleaseDate = $bios.ReleaseDate
    }
    Windows = [ordered]@{
        Caption = $os.Caption
        Version = $os.Version
        BuildNumber = $os.BuildNumber
        OSArchitecture = $os.OSArchitecture
        InstallDate = $os.InstallDate
        LastBootUpTime = $os.LastBootUpTime
    }
    TemperaturesC = $temperature
    Notes = @(
        "Diagnostico de solo lectura.",
        "No recopila contrasenas, claves API, archivos personales ni contenido del navegador.",
        "Las temperaturas pueden no aparecer: muchos equipos no las exponen via ACPI/WMI.",
        "AVX/AVX2 quedan indeterminados en este informe basico y pueden verificarse despues segun el modelo exacto de CPU."
    )
}

$jsonPath = Join-Path (Get-Location) "diagnostico-pc.json"
$txtPath = Join-Path (Get-Location) "diagnostico-pc.txt"

$report | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding UTF8

$summary = @"
=== PROYPERS25 - DIAGNOSTICO DEL PC ===
Fecha: $($report.GeneratedAt)

PC: $($report.Computer.Manufacturer) $($report.Computer.Model)
CPU: $($report.CPU.Name)
Nucleos / hilos: $($report.CPU.PhysicalCores) / $($report.CPU.LogicalProcessors)
Frecuencia maxima reportada: $($report.CPU.MaxClockMHz) MHz
RAM total: $($report.RAM.Total_GB) GB
RAM libre al medir: $($report.RAM.FreeAtCapture_GB) GB
Windows: $($report.Windows.Caption) - $($report.Windows.OSArchitecture) - build $($report.Windows.BuildNumber)

GPU:
$((($report.GPU | ForEach-Object { " - $($_.Name) | VRAM reportada: $($_.AdapterRAM_GB) GB" }) -join [Environment]::NewLine))

Discos:
$((($report.Disks | ForEach-Object { " - $($_ | ConvertTo-Json -Compress)" }) -join [Environment]::NewLine))

Placa madre: $($report.Motherboard.Manufacturer) $($report.Motherboard.Product)
BIOS: $($report.BIOS.Manufacturer) $($report.BIOS.SMBIOSBIOSVersion)

Archivos generados:
 - diagnostico-pc.json
 - diagnostico-pc.txt
"@

$summary | Set-Content -Path $txtPath -Encoding UTF8
$summary
Write-Host ""
Write-Host "Diagnostico completado. Comparte conmigo 'diagnostico-pc.json' o pega el contenido de 'diagnostico-pc.txt'." -ForegroundColor Green
