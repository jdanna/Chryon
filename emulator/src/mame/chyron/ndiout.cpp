// license:BSD-3-Clause
// copyright-holders:Joey D'Anna

// The web has no NDI. MAME's dependency scan builds this file there anyway, because maxine.cpp includes
// ndiout.h, and the scan doesn't see the #if around that include.
#if !defined(__EMSCRIPTEN__)

#include "ndiout.h"

#include <climits>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

// The few NDI SDK types used here, laid out as the SDK's Processing.NDI.structs.h and Processing.NDI.Send.h
// have them, so the SDK's headers, which come under its own licence, needn't be in the repository
struct send_create_t
{
	char const *p_ndi_name;
	char const *p_groups;
	bool clock_video;
	bool clock_audio;
};

struct video_frame_v2_t
{
	int xres, yres;
	uint32_t FourCC;
	int frame_rate_N, frame_rate_D;
	float picture_aspect_ratio;
	int frame_format_type;
	int64_t timecode;
	uint8_t *p_data;
	int line_stride_in_bytes;
	char const *p_metadata;
	int64_t timestamp;
};

constexpr uint32_t FOURCC_BGRX = 'B' | 'G' << 8 | 'R' << 16 | 'X' << 24;
constexpr int FRAME_FORMAT_INTERLEAVED = 0; // both fields in one frame
constexpr int64_t TIMECODE_SYNTHESIZE = INT64_MAX;

using send_instance = void *;
using initialize_fn = bool (*)();
using send_create_fn = send_instance (*)(send_create_t const *);
using send_destroy_fn = void (*)(send_instance);
using send_video_async_fn = void (*)(send_instance, video_frame_v2_t const *);
using get_connections_fn = int (*)(send_instance, uint32_t);

struct library
{
	bool loaded = false;
	std::string error;
	send_create_fn send_create = nullptr;
	send_destroy_fn send_destroy = nullptr;
	send_video_async_fn send_video_async = nullptr;
	get_connections_fn get_connections = nullptr;
};

// Where NDI Tools and the SDK put the runtime. The NDI_RUNTIME_DIR_V* variables are the SDK's own.
std::vector<std::string> candidates()
{
	std::vector<std::string> paths;
#if defined(_WIN32)
	char const *const name = "Processing.NDI.Lib.x64.dll";
	char const *const separator = "\\";
#elif defined(__APPLE__)
	char const *const name = "libndi.dylib";
	char const *const separator = "/";
#else
	char const *const name = "libndi.so.6";
	char const *const separator = "/";
#endif
	for (char const *variable : { "NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5" })
		if (char const *const folder = std::getenv(variable); folder && *folder)
			paths.push_back(std::string(folder) + separator + name);
#if defined(__APPLE__)
	paths.push_back("/usr/local/lib/libndi.dylib");
	paths.push_back("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib");
#elif !defined(_WIN32)
	paths.push_back("/usr/local/lib/libndi.so.6");
	paths.push_back("/usr/lib/libndi.so.6");
	paths.push_back("libndi.so.5");
	paths.push_back("/usr/local/lib/libndi.so.5");
#endif
	paths.push_back(name);
	return paths;
}

library const &load()
{
	static library lib;
	static std::once_flag once;
	std::call_once(once, []
	{
		void *handle = nullptr;
		for (std::string const &path : candidates())
		{
#if defined(_WIN32)
			handle = reinterpret_cast<void *>(LoadLibraryA(path.c_str()));
#else
			handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
#endif
			if (handle)
				break;
		}
		if (!handle)
		{
			lib.error = "The NDI runtime isn't installed. Install NDI Tools, or on Linux copy libndi.so.6 from the NDI SDK to /usr/local/lib.";
			return;
		}
		auto const symbol = [handle] (char const *name)
		{
#if defined(_WIN32)
			return reinterpret_cast<void *>(GetProcAddress(reinterpret_cast<HMODULE>(handle), name));
#else
			return dlsym(handle, name);
#endif
		};
		auto const initialize = reinterpret_cast<initialize_fn>(symbol("NDIlib_initialize"));
		lib.send_create = reinterpret_cast<send_create_fn>(symbol("NDIlib_send_create"));
		lib.send_destroy = reinterpret_cast<send_destroy_fn>(symbol("NDIlib_send_destroy"));
		lib.send_video_async = reinterpret_cast<send_video_async_fn>(symbol("NDIlib_send_send_video_async_v2"));
		lib.get_connections = reinterpret_cast<get_connections_fn>(symbol("NDIlib_send_get_no_connections"));
		if (!initialize || !lib.send_create || !lib.send_destroy || !lib.send_video_async || !lib.get_connections)
		{
			lib.error = "The NDI runtime found is missing functions this needs. Update NDI Tools.";
			return;
		}
		// The library stays loaded for the life of the process, because NDI isn't meant to be set up twice
		if (!initialize())
		{
			lib.error = "The NDI runtime wouldn't start. NDI needs a processor with SSE4.2.";
			return;
		}
		lib.loaded = true;
	});
	return lib;
}

// One NDI source, double buffered: the runtime may read a frame until the next one is sent
struct source
{
	library const &lib;
	send_instance instance = nullptr;
	std::vector<uint8_t> buffers[2];
	unsigned next = 0;

	source(library const &l, std::string const &name) : lib(l)
	{
		send_create_t const settings{ name.c_str(), nullptr, false, false }; // the machine's own clock paces it
		instance = lib.send_create(&settings);
		for (auto &buffer : buffers)
			buffer.resize(size_t(ndi_output::WIDTH) * ndi_output::HEIGHT * 4);
	}

	~source()
	{
		if (instance)
			lib.send_destroy(instance); // waits for the frame in flight
	}

	uint8_t *frame() { return buffers[next].data(); }

	void send()
	{
		video_frame_v2_t frame{};
		frame.xres = ndi_output::WIDTH;
		frame.yres = ndi_output::HEIGHT;
		frame.FourCC = FOURCC_BGRX;
		frame.frame_rate_N = 30000;
		frame.frame_rate_D = 1001;
		frame.picture_aspect_ratio = 4.0f / 3.0f; // NTSC pixels aren't square
		frame.frame_format_type = FRAME_FORMAT_INTERLEAVED;
		frame.timecode = TIMECODE_SYNTHESIZE;
		frame.p_data = buffers[next].data();
		frame.line_stride_in_bytes = ndi_output::WIDTH * 4;
		lib.send_video_async(instance, &frame);
		next ^= 1;
	}
};

} // anonymous namespace

struct ndi_output::impl
{
	std::unique_ptr<source> fill;
	std::unique_ptr<source> matte;
};

ndi_output::ndi_output(std::string const &name)
{
	library const &lib = load();
	if (!lib.loaded)
	{
		m_error = lib.error;
		return;
	}
	auto made = std::make_unique<impl>();
	made->fill = std::make_unique<source>(lib, name + " Fill");
	made->matte = std::make_unique<source>(lib, name + " Matte");
	if (!made->fill->instance || !made->matte->instance)
	{
		m_error = "NDI couldn't make the sources.";
		return;
	}
	m_impl = std::move(made);
}

ndi_output::~ndi_output() = default;

// The machine's Video is already shaped by its key, as its real output is
void ndi_output::send(uint32_t const *frame)
{
	if (!m_impl)
		return;
	uint8_t *fill = m_impl->fill->frame();
	uint8_t *matte = m_impl->matte->frame();
	for (size_t i = 0; i < size_t(WIDTH) * HEIGHT; i++, fill += 4, matte += 4)
	{
		uint32_t const pixel = frame[i];
		uint8_t const key = pixel >> 24;
		fill[0] = pixel;
		fill[1] = pixel >> 8;
		fill[2] = pixel >> 16;
		fill[3] = 0xff;
		matte[0] = matte[1] = matte[2] = key;
		matte[3] = 0xff;
	}
	m_impl->fill->send();
	m_impl->matte->send();
}

int ndi_output::fill_receivers() const
{
	return m_impl ? m_impl->fill->lib.get_connections(m_impl->fill->instance, 0) : 0;
}

int ndi_output::matte_receivers() const
{
	return m_impl ? m_impl->matte->lib.get_connections(m_impl->matte->instance, 0) : 0;
}

#endif // !__EMSCRIPTEN__
