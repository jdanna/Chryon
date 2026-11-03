// license:BSD-3-Clause
// copyright-holders:Joey D'Anna

#include "emu.h"
#include "decklinkout.h"

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>

// emulator/build.sh copies the SDK's headers for this platform to decklink/. The dispatch file finds the
// library at run time: dlopen on Linux, a CFBundle on a Mac and COM on Windows.
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include "decklink/DeckLinkAPI.h"
#include "decklink/DeckLinkAPI_i.c"
#endif
#include "decklink/DeckLinkAPIDispatch.cpp"

// Linux's and Windows' COM headers define this, and CoreFoundation's should, but it's harmless if they don't
#ifndef STDMETHODCALLTYPE
#define STDMETHODCALLTYPE
#endif

namespace {

// NTSC runs at 30000/1001 frames a second
constexpr BMDTimeScale TIME_SCALE = 30000;
constexpr BMDTimeValue FRAME_DURATION = 1001;

constexpr unsigned FRAMES = 8;
constexpr unsigned PREROLL = 3; // frames the device holds, about 100 ms
constexpr unsigned AHEAD = 2;   // finished frames waiting for it
constexpr auto STALL = std::chrono::milliseconds(500);

constexpr uint8_t BLACK[4] = { 128, 16, 128, 16 };

char const *const DUMP_NAME = "dump";

void fill_black(uint8_t *frame)
{
	for (unsigned i = 0; i < decklink_output::ROW_BYTES * decklink_output::HEIGHT; i += 4)
		std::memcpy(frame + i, BLACK, 4);
}

// COM is set up per thread, and only the machine's thread calls into the API here. The DeckLink's own
// threads call back.
IDeckLinkIterator *create_iterator()
{
#if defined(_WIN32)
	thread_local bool const com = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
	(void)com;
#endif
	return CreateDeckLinkIteratorInstance();
}

std::string display_name(IDeckLink *device)
{
	std::string result;
#if defined(_WIN32)
	BSTR name = nullptr;
	if (device->GetDisplayName(&name) != S_OK || !name)
		return result;
	int const size = WideCharToMultiByte(CP_UTF8, 0, name, -1, nullptr, 0, nullptr, nullptr);
	if (size > 1)
	{
		result.resize(size - 1);
		WideCharToMultiByte(CP_UTF8, 0, name, -1, result.data(), size, nullptr, nullptr);
	}
	SysFreeString(name);
#elif defined(__APPLE__)
	CFStringRef name = nullptr;
	if (device->GetDisplayName(&name) != S_OK || !name)
		return result;
	char buffer[256];
	if (CFStringGetCString(name, buffer, sizeof(buffer), kCFStringEncodingUTF8))
		result = buffer;
	CFRelease(name);
#else
	char const *name = nullptr;
	if (device->GetDisplayName(&name) != S_OK || !name)
		return result;
	result = name;
	std::free(const_cast<char *>(name));
#endif
	return result;
}

bool same_iid(REFIID a, REFIID b)
{
#if defined(_WIN32)
	return IsEqualIID(a, b);
#else
	return std::memcmp(&a, &b, sizeof(a)) == 0;
#endif
}

} // anonymous namespace


// The frames and the order they go out in, for the device and for the dump. A frame is either free, being
// filled or waiting (busy), or held by the device (out). The last one sent stays put, because it's shown
// again when the machine hasn't finished the next.
struct decklink_output::impl
{
	struct slot
	{
		uint8_t *bytes = nullptr;
		unsigned out = 0;
		bool busy = false;
	};

	std::mutex mutex;
	std::condition_variable changed;
	slot slots[FRAMES];
	std::deque<unsigned> waiting;
	unsigned filling = 0;
	unsigned last = 0;
	unsigned repeats = 0;
	bool stopping = false; // being closed
	bool stalled = false;  // stopped taking frames

	virtual ~impl() = default;

	// Called with the lock held, for each frame the device is to show
	unsigned take()
	{
		if (!waiting.empty())
		{
			last = waiting.front();
			waiting.pop_front();
			slots[last].busy = false;
		}
		else
			repeats++;
		slots[last].out++;
		return last;
	}

	bool find_free(unsigned &index) const
	{
		for (unsigned i = 0; i < FRAMES; i++)
			if (!slots[i].busy && !slots[i].out && i != last)
			{
				index = i;
				return true;
			}
		return false;
	}
};

namespace {

class card_output : public decklink_output::impl, public IDeckLinkVideoOutputCallback
{
public:
	std::string open(std::string const &name)
	{
		IDeckLinkIterator *const iterator = create_iterator();
		if (!iterator)
			return "No DeckLink driver";
		IDeckLink *candidate = nullptr;
		while (iterator->Next(&candidate) == S_OK)
		{
			if (!m_device && display_name(candidate) == name)
				m_device = candidate;
			else
				candidate->Release();
		}
		iterator->Release();
		if (!m_device)
			return "No DeckLink called " + name;

		if (m_device->QueryInterface(IID_IDeckLinkOutput, reinterpret_cast<void **>(&m_output)) != S_OK)
		{
			m_output = nullptr;
			return name + " has no output";
		}
#if defined(_WIN32)
		BOOL supported = FALSE;
#else
		bool supported = false;
#endif
		if (m_output->DoesSupportVideoMode(bmdVideoConnectionUnspecified, bmdModeNTSC, bmdFormat8BitYUV, bmdNoVideoOutputConversion,
				bmdSupportedVideoModeDefault, nullptr, &supported) != S_OK || !supported)
			return name + " can't play NTSC";
		if (m_output->EnableVideoOutput(bmdModeNTSC, bmdVideoOutputFlagDefault) != S_OK)
			return name + " is busy. Another program may be using it.";
		m_enabled = true;

		for (unsigned i = 0; i < FRAMES; i++)
		{
			void *bytes = nullptr;
			if (m_output->CreateVideoFrame(decklink_output::WIDTH, decklink_output::HEIGHT, decklink_output::ROW_BYTES, bmdFormat8BitYUV, bmdFrameFlagDefault, &m_frames[i]) != S_OK)
			{
				m_frames[i] = nullptr;
				return "Couldn't make frames on " + name;
			}
			m_frames[i]->GetBytes(&bytes);
			slots[i].bytes = static_cast<uint8_t *>(bytes);
			fill_black(slots[i].bytes);
		}

		m_output->SetScheduledFrameCompletionCallback(this);
		{
			std::lock_guard const lock(mutex);
			for (unsigned i = 0; i < PREROLL; i++)
				schedule(take());
			repeats = 0; // the black it starts on doesn't count
		}
		if (m_output->StartScheduledPlayback(0, TIME_SCALE, 1.0) != S_OK)
			return "Couldn't start playback on " + name;
		m_playing = true;
		return std::string();
	}

	~card_output() override
	{
		{
			std::lock_guard const lock(mutex);
			stopping = true;
		}
		changed.notify_all();
		if (m_output)
		{
			if (m_playing)
				m_output->StopScheduledPlayback(0, nullptr, 0);
			m_output->SetScheduledFrameCompletionCallback(nullptr);
			if (m_enabled)
				m_output->DisableVideoOutput();
		}
		for (auto *frame : m_frames)
			if (frame)
				frame->Release();
		if (m_output)
			m_output->Release();
		if (m_device)
			m_device->Release();
	}

	// The device hands back each frame once it's been shown, and gets the next one in its place, so it
	// always holds PREROLL frames
	HRESULT STDMETHODCALLTYPE ScheduledFrameCompleted(IDeckLinkVideoFrame *frame, BMDOutputFrameCompletionResult result) override
	{
		{
			std::lock_guard const lock(mutex);
			for (unsigned i = 0; i < FRAMES; i++)
				if (m_frames[i] == frame && slots[i].out)
					slots[i].out--;
			if (!stopping && result != bmdOutputFrameFlushed)
				schedule(take());
		}
		changed.notify_all();
		return S_OK;
	}

	HRESULT STDMETHODCALLTYPE ScheduledPlaybackHasStopped() override { return S_OK; }

	// The object belongs to decklink_output, so the count is only for the API's sake
	HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID *object) override
	{
		if (same_iid(iid, IID_IDeckLinkVideoOutputCallback))
		{
			*object = static_cast<IDeckLinkVideoOutputCallback *>(this);
			return S_OK;
		}
		*object = nullptr;
		return E_NOINTERFACE;
	}
	ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
	ULONG STDMETHODCALLTYPE Release() override { return 1; }

private:
	// With the lock held
	void schedule(unsigned index)
	{
		if (m_output->ScheduleVideoFrame(m_frames[index], m_time, FRAME_DURATION, TIME_SCALE) != S_OK)
			slots[index].out--;
		m_time += FRAME_DURATION;
	}

	IDeckLink *m_device = nullptr;
	IDeckLinkOutput *m_output = nullptr;
	IDeckLinkMutableVideoFrame *m_frames[FRAMES]{};
	BMDTimeValue m_time = 0;
	bool m_enabled = false;
	bool m_playing = false;
};


// Writes each frame the device would show to a file, on the device's schedule, so a machine without one
// can test the timing, the fields and the conversion. ffmpeg reads it as rawvideo uyvy422 720x486.
class dump_output : public decklink_output::impl
{
public:
	std::string open(char const *path)
	{
		m_file = std::fopen(path, "wb");
		if (!m_file)
			return std::string("Couldn't write ") + path;
		m_buffers = std::make_unique<uint8_t[]>(size_t(FRAMES) * FRAME_BYTES);
		for (unsigned i = 0; i < FRAMES; i++)
		{
			slots[i].bytes = &m_buffers[size_t(i) * FRAME_BYTES];
			fill_black(slots[i].bytes);
		}
		m_thread = std::thread(&dump_output::run, this);
		return std::string();
	}

	~dump_output() override
	{
		{
			std::lock_guard const lock(mutex);
			stopping = true;
		}
		changed.notify_all();
		if (m_thread.joinable())
			m_thread.join();
		if (m_file)
			std::fclose(m_file);
	}

private:
	static constexpr size_t FRAME_BYTES = size_t(decklink_output::ROW_BYTES) * decklink_output::HEIGHT;

	void run()
	{
		auto const start = std::chrono::steady_clock::now();
		int shown = -1;
		for (int64_t frame = 1; ; frame++)
		{
			std::this_thread::sleep_until(start + std::chrono::nanoseconds(frame * 100'100'000 / 3));
			unsigned index;
			{
				std::lock_guard const lock(mutex);
				if (stopping)
					return;
				if (shown >= 0)
					slots[shown].out--;
				index = take();
				shown = index;
			}
			changed.notify_all();
			std::fwrite(slots[index].bytes, 1, FRAME_BYTES, m_file);
			std::fflush(m_file);
		}
	}

	std::FILE *m_file = nullptr;
	std::unique_ptr<uint8_t[]> m_buffers;
	std::thread m_thread;
};

} // anonymous namespace


decklink_output::listing decklink_output::devices()
{
	listing result;
	if (IDeckLinkIterator *const iterator = create_iterator())
	{
		result.driver = true;
		IDeckLink *device = nullptr;
		while (iterator->Next(&device) == S_OK)
		{
			IDeckLinkOutput *output = nullptr;
			if (device->QueryInterface(IID_IDeckLinkOutput, reinterpret_cast<void **>(&output)) == S_OK)
			{
				result.names.push_back(display_name(device));
				output->Release();
			}
			device->Release();
		}
		iterator->Release();
	}
	if (std::getenv("MAXINE_DECKLINK_DUMP"))
		result.names.push_back(DUMP_NAME);
	return result;
}

// Names go last, because they can have spaces
std::string decklink_output::report()
{
	listing const found = devices();
	if (!found.driver && found.names.empty())
		return "MAXINE_DECKLINK_NODRIVER\n";
	std::string lines;
	for (std::string const &name : found.names)
		lines += "MAXINE_DECKLINK_DEVICE " + name + "\n";
	return lines + "MAXINE_DECKLINK_DEVICES " + std::to_string(found.names.size()) + "\n";
}

// MAXINE! Studio lists devices while the emulator is stopped by starting it with MAXINE_DECKLINK_LIST set. This
// runs as the program loads, so it prints the list and exits before MAME starts.
[[maybe_unused]] static int const s_list_only = []
{
	if (!std::getenv("MAXINE_DECKLINK_LIST"))
		return 0;
	std::fputs(decklink_output::report().c_str(), stdout);
	std::fflush(stdout);
	std::exit(0);
}();

decklink_output::decklink_output(std::string const &name)
{
	char const *const dump_path = std::getenv("MAXINE_DECKLINK_DUMP");
	if (dump_path && name == DUMP_NAME)
	{
		auto dump = std::make_unique<dump_output>();
		m_error = dump->open(dump_path);
		m_impl = std::move(dump);
	}
	else
	{
		auto card = std::make_unique<card_output>();
		m_error = card->open(name);
		m_impl = std::move(card);
	}
	if (!m_error.empty())
		m_impl.reset();
}

decklink_output::~decklink_output() = default;

uint8_t *decklink_output::next_frame()
{
	if (!m_impl)
		return nullptr;
	impl &q = *m_impl;
	std::unique_lock lock(q.mutex);
	unsigned index = 0;
	if (!q.changed.wait_for(lock, STALL, [&] { return q.stalled || (q.waiting.size() < AHEAD && q.find_free(index)); }))
		q.stalled = true;
	if (q.stalled)
		return nullptr;
	q.slots[index].busy = true;
	q.filling = index;
	return q.slots[index].bytes;
}

void decklink_output::submit_frame()
{
	if (!m_impl)
		return;
	std::lock_guard const lock(m_impl->mutex);
	m_impl->waiting.push_back(m_impl->filling);
}

unsigned decklink_output::repeats() const
{
	if (!m_impl)
		return 0;
	std::lock_guard const lock(m_impl->mutex);
	return m_impl->repeats;
}

// Rec. 601 in studio range, 16 to 235 for luma. Each pair of pixels shares its chroma, from their sum.
void decklink_output::convert_row(uint32_t const *source, uint8_t *dest, bool key)
{
	for (unsigned x = 0; x < WIDTH; x += 2, dest += 4)
	{
		uint32_t const a = source[x], b = source[x + 1];
		if (key)
		{
			dest[0] = dest[2] = 128;
			dest[1] = 16 + (BIT(a, 24, 8) * 219 + 127) / 255;
			dest[3] = 16 + (BIT(b, 24, 8) * 219 + 127) / 255;
			continue;
		}
		int const r0 = BIT(a, 16, 8), g0 = BIT(a, 8, 8), b0 = BIT(a, 0, 8);
		int const r1 = BIT(b, 16, 8), g1 = BIT(b, 8, 8), b1 = BIT(b, 0, 8);
		int const r = r0 + r1, g = g0 + g1, bl = b0 + b1;
		dest[0] = 128 + ((-38 * r - 74 * g + 112 * bl + 256) >> 9);
		dest[1] = 16 + ((66 * r0 + 129 * g0 + 25 * b0 + 128) >> 8);
		dest[2] = 128 + ((112 * r - 94 * g - 18 * bl + 256) >> 9);
		dest[3] = 16 + ((66 * r1 + 129 * g1 + 25 * b1 + 128) >> 8);
	}
}
