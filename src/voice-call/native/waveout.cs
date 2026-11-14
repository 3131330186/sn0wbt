// waveOut helper for the voice-call probe (loaded by waveout.ps1 via Add-Type).
//
// Why winmm waveOut instead of WASAPI/NAudio:
//   - zero external dependency (no DLL download, no NuGet)
//   - device selection by index is native to the API (waveOutOpen uDeviceID)
//   - C# 5 compatible: compiles with the in-box compiler on PS 5.1
//
// ASCII only on purpose (PowerShell 5.1 file-encoding quirks).
// Known limitation (documented): loads whole file into memory - probe tones are
// tiny; Phase 2 TTS playback must switch to chunked waveOutWrite queueing.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WaveOutUtil
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WAVEOUTCAPS
    {
        public ushort wMid;
        public ushort wPid;
        public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szPname;
        public uint dwFormats;
        public ushort wChannels;
        public ushort wReserved1;
        public uint dwSupport;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WAVEHDR
    {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    [DllImport("winmm.dll")]
    private static extern uint waveOutGetNumDevs();

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    private static extern int waveOutGetDevCapsW(UIntPtr uDeviceID, ref WAVEOUTCAPS pwoc, uint cbwoc);

    [DllImport("winmm.dll")]
    private static extern int waveOutOpen(out IntPtr phwo, UIntPtr uDeviceID, ref WAVEFORMATEX pwfx, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);

    [DllImport("winmm.dll")]
    private static extern int waveOutClose(IntPtr hwo);

    [DllImport("winmm.dll")]
    private static extern int waveOutPrepareHeader(IntPtr hwo, ref WAVEHDR pwh, uint cbwh);

    [DllImport("winmm.dll")]
    private static extern int waveOutUnprepareHeader(IntPtr hwo, ref WAVEHDR pwh, uint cbwh);

    [DllImport("winmm.dll")]
    private static extern int waveOutWrite(IntPtr hwo, ref WAVEHDR pwh, uint cbwh);

    [DllImport("winmm.dll")]
    private static extern int waveOutReset(IntPtr hwo);

    private static AutoResetEvent s_done = new AutoResetEvent(false);

    private const int CALLBACK_EVENT = 0x50000;
    private const int PLAY_TIMEOUT_MS = 120000;

    // Lists playback devices as "index|name" lines.
    public static string ListDevices()
    {
        uint n = waveOutGetNumDevs();
        StringBuilder sb = new StringBuilder();
        for (uint i = 0; i < n; i++)
        {
            WAVEOUTCAPS caps = new WAVEOUTCAPS();
            int r = waveOutGetDevCapsW((UIntPtr)i, ref caps, (uint)Marshal.SizeOf(typeof(WAVEOUTCAPS)));
            if (r == 0)
            {
                sb.Append(i).Append('|').Append(caps.szPname).Append('\n');
            }
        }
        return sb.ToString();
    }

    // Plays a 16-bit PCM WAV file on the given device. Returns 0 on success,
    // small codes for wav parse errors, 100000+ for waveOut API errors.
    public static int PlayFile(int deviceId, string path)
    {
        byte[] pcm;
        WAVEFORMATEX fmt;
        int pr = ParsePcmWav(path, out pcm, out fmt);
        if (pr != 0) return pr;

        UIntPtr dev;
        if (deviceId < 0)
        {
            ulong allOnes = unchecked((ulong)(long)-1);   // WAVE_MAPPER
            dev = new UIntPtr(allOnes);
        }
        else
        {
            dev = new UIntPtr((ulong)(uint)deviceId);
        }

        IntPtr h;
        IntPtr ev = s_done.SafeWaitHandle.DangerousGetHandle();
        int r = waveOutOpen(out h, dev, ref fmt, ev, IntPtr.Zero, CALLBACK_EVENT);
        if (r != 0) return 100000 + r;

        IntPtr p = IntPtr.Zero;
        WAVEHDR hdr = new WAVEHDR();
        try
        {
            p = Marshal.AllocHGlobal(pcm.Length);
            Marshal.Copy(pcm, 0, p, pcm.Length);
            hdr.lpData = p;
            hdr.dwBufferLength = (uint)pcm.Length;

            int pr2 = waveOutPrepareHeader(h, ref hdr, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            if (pr2 != 0) return 200000 + pr2;

            s_done.Reset();
            int wr = waveOutWrite(h, ref hdr, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            if (wr != 0)
            {
                waveOutReset(h);
                waveOutUnprepareHeader(h, ref hdr, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
                return 300000 + wr;
            }

            if (!s_done.WaitOne(PLAY_TIMEOUT_MS))
            {
                waveOutReset(h);
                return 400000;
            }

            waveOutUnprepareHeader(h, ref hdr, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            return 0;
        }
        finally
        {
            if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
            waveOutClose(h);
        }
    }

    // Minimal PCM WAV parser: walks chunks, requires 16-bit PCM "fmt " + "data".
    private static int ParsePcmWav(string path, out byte[] pcm, out WAVEFORMATEX fmt)
    {
        pcm = null;
        fmt = new WAVEFORMATEX();
        try
        {
            byte[] f = File.ReadAllBytes(path);
            if (f.Length < 44) return 1;
            if (f[0] != 'R' || f[1] != 'I' || f[2] != 'F' || f[3] != 'F') return 1;
            if (f[8] != 'W' || f[9] != 'A' || f[10] != 'V' || f[11] != 'E') return 1;

            int off = 12;
            bool fmtFound = false;
            int dataOff = -1;
            int dataLen = 0;
            while (off + 8 <= f.Length)
            {
                string id = Encoding.ASCII.GetString(f, off, 4);
                uint sz = BitConverter.ToUInt32(f, off + 4);
                if (id == "fmt ")
                {
                    fmt.wFormatTag = BitConverter.ToUInt16(f, off + 8);
                    fmt.nChannels = BitConverter.ToUInt16(f, off + 10);
                    fmt.nSamplesPerSec = BitConverter.ToUInt32(f, off + 12);
                    fmt.nAvgBytesPerSec = BitConverter.ToUInt32(f, off + 16);
                    fmt.nBlockAlign = BitConverter.ToUInt16(f, off + 20);
                    fmt.wBitsPerSample = BitConverter.ToUInt16(f, off + 22);
                    fmt.cbSize = 0;
                    fmtFound = true;
                }
                else if (id == "data")
                {
                    dataOff = off + 8;
                    dataLen = (int)Math.Min((long)sz, (long)f.Length - dataOff);
                }
                off += 8 + (int)((sz + 1u) & ~1u);   // chunks are word-aligned
            }

            if (!fmtFound || dataOff < 0 || dataLen <= 0) return 2;
            if (fmt.wFormatTag != 1 || fmt.wBitsPerSample != 16) return 3;

            pcm = new byte[dataLen];
            Array.Copy(f, dataOff, pcm, 0, dataLen);
            return 0;
        }
        catch
        {
            return 9;
        }
    }

    // =====================================================================
    // WASAPI loopback capture (channel B): listens to a RENDER endpoint
    // (whatever QQ plays to it) and streams s16le MONO to stdout.
    // Uses the endpoint mix format (usually float32 48k); Node resamples.
    // =====================================================================

    private static class ComGuids
    {
        public static readonly Guid IID_IMMDeviceEnumerator = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
        public static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        public static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        int RegisterEndpointNotificationCallback(IntPtr pClient);
        int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        int GetCount(out int pcDevices);
        int Item(int nDevice, out IMMDevice ppDevice);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out int pdwState);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        int GetCount(out int cProps);
        int GetAt(int iProp, out PROPERTYKEY pkey);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PROPVARIANT pv);

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        int GetBufferSize(out uint numBufferFrames);
        int GetStreamLatency(out long pnsLatency);
        int GetCurrentPadding(out uint pNumPaddingFrames);
        int IsFormatSupported(int shareMode, IntPtr pFormat, IntPtr ppClosestMatch);
        int GetMixFormat(out IntPtr ppDeviceFormat);
        int GetDevicePeriod(out long pDefaultDevicePeriod, out long pMinDevicePeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr ppData, out uint pNumFrames, out int pdwFlags, out long pu64DevicePosition, out long pu64QPCPosition);
        int ReleaseBuffer(uint pNumFrames);
        int GetNextPacketSize(out uint pNumFrames);
    }

    private const int eRender = 0;
    private const int DEVICE_STATE_ACTIVE = 1;
    private const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;

    private static string GetFriendlyName(IMMDevice d)
    {
        try
        {
            IPropertyStore ps;
            int r = d.OpenPropertyStore(0, out ps);   // STGM_READ
            if (r != 0) return "";
            PROPERTYKEY key;
            key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
            key.pid = 14;                              // PKEY_Device_FriendlyName
            PROPVARIANT pv;
            r = ps.GetValue(ref key, out pv);
            if (r != 0) return "";
            string s = "";
            if (pv.vt == 31 && pv.pointerValue != IntPtr.Zero)   // VT_LPWSTR
            {
                s = Marshal.PtrToStringUni(pv.pointerValue) ?? "";
            }
            PropVariantClear(ref pv);
            return s.Replace('\n', ' ').Replace('\r', ' ');
        }
        catch { return ""; }
    }

    private static IMMDeviceCollection RenderEndpoints()
    {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDeviceCollection col;
        int r = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col);
        if (r != 0) return null;
        return col;
    }

    // Lists active render endpoints as one friendly name per line.
    public static string ListRenderEndpoints()
    {
        StringBuilder sb = new StringBuilder();
        IMMDeviceCollection col = RenderEndpoints();
        if (col == null) return "";
        int n;
        col.GetCount(out n);
        for (int i = 0; i < n; i++)
        {
            IMMDevice d;
            if (col.Item(i, out d) == 0) sb.Append(GetFriendlyName(d)).Append('\n');
        }
        return sb.ToString();
    }

    private static IMMDevice FindRenderBySubstring(string substring)
    {
        IMMDeviceCollection col = RenderEndpoints();
        if (col == null) return null;
        int n;
        col.GetCount(out n);
        for (int i = 0; i < n; i++)
        {
            IMMDevice d;
            if (col.Item(i, out d) != 0) continue;
            string name = GetFriendlyName(d);
            if (name.Length > 0 && name.IndexOf(substring, StringComparison.OrdinalIgnoreCase) >= 0) return d;
        }
        return null;
    }

    // Streams loopback capture of the named render endpoint to stdout as
    // s16le mono at the endpoint mix rate. Header line to stderr first:
    //   #loopback rate=<hz> ch=<n> bits=<n>
    // Blocks until the process is killed. Returns small error codes.
    public static int LoopCapture(string deviceSubstring)
    {
        IMMDevice device = FindRenderBySubstring(deviceSubstring);
        if (device == null) return 10;

        object ao;
        Guid iidAC = ComGuids.IID_IAudioClient;
        int r = device.Activate(ref iidAC, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out ao);
        if (r != 0) return 11;
        IAudioClient ac = (IAudioClient)ao;

        IntPtr fmtPtr;
        r = ac.GetMixFormat(out fmtPtr);
        if (r != 0) return 12;
        WAVEFORMATEX mix = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));

        // 200ms buffer in 100ns units; shared + loopback
        r = ac.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, fmtPtr, IntPtr.Zero);
        if (r != 0) return 13;

        object so;
        Guid iidCap = ComGuids.IID_IAudioCaptureClient;
        r = ac.GetService(ref iidCap, out so);
        if (r != 0) return 14;
        IAudioCaptureClient cap = (IAudioCaptureClient)so;

        Console.Error.WriteLine("#loopback rate=" + mix.nSamplesPerSec + " ch=" + mix.nChannels + " bits=" + mix.wBitsPerSample);

        Stream stdout = Console.OpenStandardOutput();
        r = ac.Start();
        if (r != 0) return 15;

        float[] floatBuf = null;
        int[] int32Buf = null;
        byte[] outBuf = new byte[1 << 16];
        bool isFloat = mix.wBitsPerSample == 32 && (mix.wFormatTag == 3 || mix.wFormatTag == 0xFFFE);

        while (true)
        {
            uint packet;
            cap.GetNextPacketSize(out packet);
            while (packet > 0)
            {
                IntPtr data; uint frames; int flags; long p1; long p2;
                cap.GetBuffer(out data, out frames, out flags, out p1, out p2);
                if (frames > 0)
                {
                    int ch = mix.nChannels > 0 ? mix.nChannels : 2;
                    int total = (int)frames * ch;
                    int written = 0;
                    bool silent = (flags & 0x2) != 0;   // AUDCLNT_BUFFERFLAGS_SILENT

                    if (!silent && data != IntPtr.Zero && mix.wBitsPerSample == 32)
                    {
                        if (isFloat)
                        {
                            if (floatBuf == null || floatBuf.Length < total) floatBuf = new float[total];
                            Marshal.Copy(data, floatBuf, 0, total);
                            for (int f = 0; f < (int)frames; f++)
                            {
                                double acc = 0;
                                for (int c = 0; c < ch; c++) acc += floatBuf[f * ch + c];
                                acc /= ch;
                                if (acc > 1) acc = 1; else if (acc < -1) acc = -1;
                                short v = (short)Math.Round(acc * 32767);
                                outBuf[written++] = (byte)(v & 0xFF);
                                outBuf[written++] = (byte)((v >> 8) & 0xFF);
                            }
                        }
                        else
                        {
                            if (int32Buf == null || int32Buf.Length < total) int32Buf = new int[total];
                            Marshal.Copy(data, int32Buf, 0, total);
                            for (int f = 0; f < (int)frames; f++)
                            {
                                long acc = 0;
                                for (int c = 0; c < ch; c++) acc += int32Buf[f * ch + c] >> 16;
                                acc /= ch;
                                if (acc > 32767) acc = 32767; else if (acc < -32768) acc = -32768;
                                short v = (short)acc;
                                outBuf[written++] = (byte)(v & 0xFF);
                                outBuf[written++] = (byte)((v >> 8) & 0xFF);
                            }
                        }
                    }
                    else if (!silent && data != IntPtr.Zero && mix.wBitsPerSample == 16)
                    {
                        // int16 interleaved: average channels on the fly
                        for (int f = 0; f < (int)frames; f++)
                        {
                            int acc = 0;
                            for (int c = 0; c < ch; c++) acc += Marshal.ReadInt16(data, (f * ch + c) * 2);
                            acc /= ch;
                            short v = (short)acc;
                            outBuf[written++] = (byte)(v & 0xFF);
                            outBuf[written++] = (byte)((v >> 8) & 0xFF);
                        }
                    }
                    else
                    {
                        written = (int)frames * 2;   // silent → zeros
                        for (int j = 0; j < written; j++) outBuf[j] = 0;
                    }

                    if (written > 0)
                    {
                        stdout.Write(outBuf, 0, written);
                        stdout.Flush();
                    }
                }
                cap.ReleaseBuffer(frames);
                cap.GetNextPacketSize(out packet);
            }
            System.Threading.Thread.Sleep(15);
        }
    }
}
