using Microsoft.AspNetCore.Mvc;
using ITrack.api.Dtos;
using ITrack.api.Services;

namespace ITrack.api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class MarketController : ControllerBase
{
    private readonly MarketService _marketService;

    public MarketController(MarketService marketService)
    {
        _marketService = marketService;
    }

    [HttpGet("ping")]
    public IActionResult Ping()
    {
        return Ok(new { status = "ok", message = "ITrack API OK" });
    }

    [HttpGet("summary")]
    public async Task<ActionResult<MarketSummaryDto>> GetSummary(
        string region = "ottawa",
        int days = 7,
        string? areas = null,
        CancellationToken cancellationToken = default)
    {
        var areaList = string.IsNullOrWhiteSpace(areas)
            ? null
            : areas.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var dto = await _marketService.GetSummaryAsync(region, days, areaList, cancellationToken);
        return Ok(dto);
    }

    [HttpGet("regions")]
    public ActionResult<IReadOnlyList<string>> GetSupportedRegions()
    {
        return Ok(_marketService.GetSupportedRegions());
    }

    [HttpGet("jobs")]
    public async Task<ActionResult<List<JobListingDto>>> GetJobs(
        string region = "ottawa",
        string? location = null,
        double? centerLat = null,
        double? centerLng = null,
        int radiusKm = 10,
        int days = 30,
        string? areas = null,
        string? techs = null,
        CancellationToken cancellationToken = default)
    {
        var areaList = string.IsNullOrWhiteSpace(areas)
            ? []
            : areas.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var techList = string.IsNullOrWhiteSpace(techs)
            ? []
            : techs.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var jobs = await _marketService.GetJobsAsync(
            region,
            location,
            centerLat,
            centerLng,
            radiusKm,
            days,
            areaList,
            techList,
            cancellationToken);
        return Ok(jobs);
    }
}