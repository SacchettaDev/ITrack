using ITrack.api.Dtos;
using Microsoft.Extensions.Options;
using Npgsql;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text;
using System.Collections.Concurrent;

namespace ITrack.api.Services;

public class MarketService
{
    private readonly HttpClient _httpClient;
    private readonly AdzunaOptions _adzuna;
    private readonly SerpApiOptions _serpApi;
    private readonly string _snapshotConnectionString;
    private static readonly ConcurrentDictionary<string, (double Lat, double Lng, string Precision)> LocationGeoCache = new(StringComparer.OrdinalIgnoreCase);

    public MarketService(
        HttpClient httpClient,
        IOptions<AdzunaOptions> adzunaOptions,
        IOptions<SerpApiOptions> serpApiOptions,
        IConfiguration configuration)
    {
        _httpClient = httpClient;
        _adzuna = adzunaOptions.Value;
        _serpApi = serpApiOptions.Value;
        _snapshotConnectionString = configuration.GetConnectionString("JobsSnapshotDb") ?? "";
    }

    private static readonly Dictionary<string, RegionProfile> RegionProfiles = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ottawa"] = new RegionProfile(
            DisplayName: "Ottawa",
            BaseTotalJobs: 520,
            RemotePercentage: 58,
            MedianSalary: 112000,
            HeatScore: 79,
            FieldDistribution: new Dictionary<string, double>
            {
                ["Cybersecurity"] = 0.24,
                ["Cloud/DevOps"] = 0.21,
                ["Full-Stack"] = 0.27,
                ["Data/AI"] = 0.18,
                ["QA"] = 0.10
            }),
        ["gatineau"] = new RegionProfile(
            DisplayName: "Gatineau",
            BaseTotalJobs: 210,
            RemotePercentage: 49,
            MedianSalary: 98000,
            HeatScore: 68,
            FieldDistribution: new Dictionary<string, double>
            {
                ["Cybersecurity"] = 0.20,
                ["Cloud/DevOps"] = 0.18,
                ["Full-Stack"] = 0.29,
                ["Data/AI"] = 0.16,
                ["QA"] = 0.17
            }),
        ["kanata"] = new RegionProfile(
            DisplayName: "Kanata",
            BaseTotalJobs: 315,
            RemotePercentage: 54,
            MedianSalary: 109000,
            HeatScore: 74,
            FieldDistribution: new Dictionary<string, double>
            {
                ["Embedded/IoT"] = 0.26,
                ["Cloud/DevOps"] = 0.22,
                ["Full-Stack"] = 0.20,
                ["Data/AI"] = 0.17,
                ["QA"] = 0.15
            }),
        ["ottawa-gatineau"] = new RegionProfile(
            DisplayName: "Ottawa-Gatineau",
            BaseTotalJobs: 740,
            RemotePercentage: 56,
            MedianSalary: 108000,
            HeatScore: 76,
            FieldDistribution: new Dictionary<string, double>
            {
                ["Cybersecurity"] = 0.22,
                ["Cloud/DevOps"] = 0.20,
                ["Full-Stack"] = 0.26,
                ["Data/AI"] = 0.18,
                ["QA"] = 0.14
            })
    };

    private static readonly Dictionary<string, string> RegionAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ottawa region"] = "ottawa",
        ["ottawa-gatineau region"] = "ottawa-gatineau",
        ["national capital region"] = "ottawa-gatineau",
        ["ncr"] = "ottawa-gatineau"
    };
    private static readonly HashSet<string> SupportedAreas = new(StringComparer.OrdinalIgnoreCase)
    {
        "Cybersecurity",
        "Back-End",
        "Front-End",
        "Data",
        "Cloud",
        "Full-Stack",
        "Quality Assurance"
    };

    /// <summary>
    /// Aligns with /jobs: all seven areas selected clears the filter; Full-Stack enables title-pattern expansion in SQL.
    /// </summary>
    private static (HashSet<string> AreaSet, bool FilterAreas, bool ExpandFullStackTitle) NormalizeAreaFilterForQuery(
        IEnumerable<string>? areas)
    {
        var areaSet = (areas ?? [])
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var allAreasSelected = SupportedAreas.All(areaSet.Contains) && areaSet.Count >= SupportedAreas.Count;
        if (allAreasSelected)
        {
            areaSet.Clear();
        }

        var filterAreas = areaSet.Count > 0;
        var expandFs = filterAreas && areaSet.Contains("Full-Stack");
        return (areaSet, filterAreas, expandFs);
    }

    /// <summary>
    /// Extra WHERE fragment for job_snapshot: mirrors data-pipeline matches_location_bucket and Curated-ottawa- / Curated-gatineau- source prefixes.
    /// Unknown region slug defaults to Ottawa-side filter (same as profile fallback).
    /// </summary>
    private static string BuildSnapshotRegionAndClause(string normalizedRegion)
    {
        var key = RegionProfiles.ContainsKey(normalizedRegion) ? normalizedRegion : "ottawa";

        if (string.Equals(key, "ottawa-gatineau", StringComparison.OrdinalIgnoreCase))
        {
            return "";
        }

        if (string.Equals(key, "gatineau", StringComparison.OrdinalIgnoreCase))
        {
            // %-gatineau-% = Curated-gatineau-Front-End; %-gatineau = LinkedIn-gatineau (fim do token)
            return """
                  AND (
                    LOWER(COALESCE(location_text, '')) ~* 'gatineau|hull|aylmer|masson|buckingham|chelsea|cantley'
                    OR LOWER(COALESCE(source, '')) LIKE '%-gatineau-%'
                    OR LOWER(COALESCE(source, '')) LIKE '%-gatineau'
                    OR LOWER(COALESCE(source, '')) LIKE 'curated-gatineau-%'
                  )
                """;
        }

        if (string.Equals(key, "kanata", StringComparison.OrdinalIgnoreCase))
        {
            // Kanata deve focar o cluster local (não todo Ottawa), incluindo sources marcados como -kanata.
            return """
                  AND (
                    LOWER(COALESCE(location_text, '')) ~* 'kanata|stittsville|carp'
                    OR LOWER(COALESCE(source, '')) LIKE '%-kanata-%'
                    OR LOWER(COALESCE(source, '')) LIKE '%-kanata'
                    OR LOWER(COALESCE(source, '')) LIKE 'curated-kanata-%'
                  )
                """;
        }

        if (string.Equals(key, "ottawa", StringComparison.OrdinalIgnoreCase))
        {
            // %-ottawa-% não apanha "LinkedIn-ottawa" nem sufixo sem hífen final — vagas Remote/Canada sumiam.
            return """
                  AND (
                    (
                      LOWER(COALESCE(location_text, '')) ~* 'ottawa|kanata|nepean|orleans|gloucester|barrhaven|stittsville|carp|manotick|rockland|carleton[[:space:]]place|arnprior|kemptville|prescott|smiths[[:space:]]falls|perth'
                      OR LOWER(COALESCE(source, '')) LIKE '%-ottawa-%'
                      OR LOWER(COALESCE(source, '')) LIKE '%-ottawa'
                      OR LOWER(COALESCE(source, '')) LIKE 'curated-ottawa-%'
                    )
                    AND NOT (
                      (LOWER(COALESCE(location_text, '')) ~* 'gatineau|hull|aylmer')
                      AND LOWER(COALESCE(location_text, '')) !~* 'ottawa|kanata'
                    )
                  )
                """;
        }

        return "";
    }

    /// <summary>
    /// WHERE fragment: drop chip-design roles (ASIC/Verilog, etc.) so they do not count as IT software — matches Python import rules.
    /// </summary>
    private static string BuildSnapshotExcludeHardwareChipAndClause() =>
        """
                  AND NOT (
                    LOWER(title) ~* '(^|[^[:alnum:]])(asic|vlsi|verilog|rfic|system[[:space:]-]+verilog)([^[:alnum:]]|$)'
                    OR LOWER(title) ~* '(^|[^[:alnum:]]+)fpga([^[:alnum:]]|$)'
                    OR LOWER(title) ~* 'physical[[:space:]]+design'
                    OR LOWER(title) ~* 'mask[[:space:]]+design'
                    OR LOWER(title) ~* 'mixed[[:space:]-]+signal'
                    OR LOWER(title) ~* 'analog[[:space:]]+(ic[[:space:]]+)?(design|engineer)'
                    OR LOWER(title) ~* 'layout[[:space:]]+engineer'
                    OR LOWER(title) ~* 'dft[[:space:]]+engineer'
                  )
                  AND NOT (
                    LOWER(title) LIKE '%synthesis%'
                    AND title ~* '[[:<:]]sta[[:>:]]'
                    AND LOWER(title) NOT LIKE '%software%'
                    AND LOWER(title) NOT LIKE '%front%'
                  )
                """;

    private static readonly string[] AdzunaSearchTerms =
    [
        "software developer",
        "full stack developer",
        "data engineer",
        "cloud engineer",
        "cybersecurity analyst"
    ];
    private static readonly Dictionary<string, (double Lat, double Lng, string Precision)> KnownLocationCoordinates = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ottawa"] = (45.4215, -75.6972, "city"),
        ["ottawa, on"] = (45.4215, -75.6972, "city"),
        ["kanata"] = (45.3091, -75.9137, "estimated"),
        ["nepean"] = (45.3460, -75.7700, "estimated"),
        ["orleans"] = (45.4690, -75.5150, "estimated"),
        ["gloucester"] = (45.4340, -75.6100, "estimated"),
        ["barrhaven"] = (45.2660, -75.7490, "estimated"),
        ["gatineau"] = (45.4765, -75.7013, "estimated"),
        ["downtown ottawa"] = (45.4215, -75.6972, "estimated")
    };

    public IReadOnlyList<string> GetSupportedRegions()
    {
        return RegionProfiles.Keys.OrderBy(x => x).ToList();
    }

    public async Task<MarketSummaryDto> GetSummaryAsync(
        string region,
        int days,
        IEnumerable<string>? areas = null,
        CancellationToken cancellationToken = default)
    {
        var normalizedRegion = NormalizeRegion(region);
        days = Math.Clamp(days, 1, 90);

        var profile = RegionProfiles.TryGetValue(normalizedRegion, out var found)
            ? found
            : RegionProfiles["ottawa"];

        // Same PostgreSQL rules as /jobs snapshot path so chart counts match area filters (e.g. Full-Stack).
        if (!string.IsNullOrWhiteSpace(_snapshotConnectionString))
        {
            var fromSnapshot = await TryBuildSummaryFromSnapshotAsync(profile, days, areas, normalizedRegion, cancellationToken);
            if (fromSnapshot != null)
            {
                return fromSnapshot;
            }
        }

        var growthFactor = 1 + (days / 60.0); // períodos maiores trazem mais vagas agregadas

        var externalSnapshot = await TryFetchFromAdzunaAsync(profile.DisplayName, days, cancellationToken);
        var totalJobs = externalSnapshot?.TotalJobs ?? (int)Math.Round(profile.BaseTotalJobs * growthFactor);
        var remotePercentage = externalSnapshot?.RemotePercentage ?? profile.RemotePercentage;
        var medianSalary = externalSnapshot?.MedianSalary ?? profile.MedianSalary;
        var jobsByField = externalSnapshot?.JobsByField;
        var jobsOverTime = externalSnapshot?.JobsOverTime;

        return new MarketSummaryDto
        {
            Region = profile.DisplayName,
            PeriodDays = days,
            Kpis = new MarketKpisDto
            {
                TotalJobs = totalJobs,
                RemotePercentage = remotePercentage,
                MedianSalary = medianSalary,
                HeatScore = profile.HeatScore
            },
            Charts = new MarketChartsDto
            {
                JobsByField = jobsByField ?? BuildJobsByField(profile, totalJobs),
                JobsOverTime = jobsOverTime ?? BuildJobsOverTime(profile, days, totalJobs)
            }
        };
    }

    /// <summary>
    /// Aggregates KPI/charts from job_snapshot. Totals / by-area match listagens (sem filtro posted_date no dump curado).
    /// Jobs-over-time ainda usa o período para o gráfico de datas conhecidas.
    /// </summary>
    private async Task<MarketSummaryDto?> TryBuildSummaryFromSnapshotAsync(
        RegionProfile profile,
        int days,
        IEnumerable<string>? areas,
        string normalizedRegion,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var conn = new NpgsqlConnection(_snapshotConnectionString);
            await conn.OpenAsync(cancellationToken);

            var dateThreshold = DateTime.UtcNow.Date.AddDays(-(days - 1));
            var (areaSet, filterAreas, expandFsTitle) = NormalizeAreaFilterForQuery(areas);
            var areasArr = filterAreas ? areaSet.ToArray() : Array.Empty<string>();
            var regionAnd = BuildSnapshotRegionAndClause(normalizedRegion);
            var chipAnd = BuildSnapshotExcludeHardwareChipAndClause();

            var sqlTotal = $"""
                SELECT COUNT(*)::bigint
                FROM job_snapshot
                WHERE (NOT @filter_areas OR (
                        area = ANY(@areas)
                        OR (@expand_fs_title AND (
                            LOWER(title) LIKE '%full stack%'
                            OR LOWER(title) LIKE '%full-stack%'
                            OR LOWER(title) LIKE '%fullstack%'
                        ))
                    ))
                {regionAnd}
                {chipAnd}
                """;

            long totalJobs = 0;
            await using (var cmd = new NpgsqlCommand(sqlTotal, conn))
            {
                cmd.Parameters.AddWithValue("filter_areas", filterAreas);
                cmd.Parameters.Add(new NpgsqlParameter("areas", areasArr) { DataTypeName = "text[]" });
                cmd.Parameters.AddWithValue("expand_fs_title", expandFsTitle);
                var scalar = await cmd.ExecuteScalarAsync(cancellationToken);
                if (scalar is long l)
                {
                    totalJobs = l;
                }
                else if (scalar is int i)
                {
                    totalJobs = i;
                }
            }

            if (totalJobs == 0)
            {
                return null;
            }

            var sqlAreas = $"""
                SELECT area, COUNT(*)::int
                FROM job_snapshot
                WHERE (NOT @filter_areas OR (
                        area = ANY(@areas)
                        OR (@expand_fs_title AND (
                            LOWER(title) LIKE '%full stack%'
                            OR LOWER(title) LIKE '%full-stack%'
                            OR LOWER(title) LIKE '%fullstack%'
                        ))
                    ))
                {regionAnd}
                {chipAnd}
                GROUP BY area
                ORDER BY COUNT(*) DESC
                """;

            var jobsByField = new List<JobsByFieldPointDto>();
            await using (var cmdAreas = new NpgsqlCommand(sqlAreas, conn))
            {
                cmdAreas.Parameters.AddWithValue("filter_areas", filterAreas);
                cmdAreas.Parameters.Add(new NpgsqlParameter("areas", areasArr) { DataTypeName = "text[]" });
                cmdAreas.Parameters.AddWithValue("expand_fs_title", expandFsTitle);
                await using var reader = await cmdAreas.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken))
                {
                    jobsByField.Add(new JobsByFieldPointDto
                    {
                        Field = reader.GetString(0),
                        Count = reader.GetInt32(1)
                    });
                }
            }

            var today = DateOnly.FromDateTime(DateTime.UtcNow);
            var startDate = today.AddDays(-(days - 1));
            var countsByDate = new Dictionary<DateOnly, int>();

            var sqlOverTime = $"""
                SELECT posted_date::date AS d, COUNT(*)::int
                FROM job_snapshot
                WHERE posted_date >= @date_from::date
                  AND (NOT @filter_areas OR (
                        area = ANY(@areas)
                        OR (@expand_fs_title AND (
                            LOWER(title) LIKE '%full stack%'
                            OR LOWER(title) LIKE '%full-stack%'
                            OR LOWER(title) LIKE '%fullstack%'
                        ))
                    ))
                {regionAnd}
                {chipAnd}
                GROUP BY posted_date
                ORDER BY posted_date
                """;

            await using (var cmdOt = new NpgsqlCommand(sqlOverTime, conn))
            {
                cmdOt.Parameters.AddWithValue("date_from", dateThreshold);
                cmdOt.Parameters.AddWithValue("filter_areas", filterAreas);
                cmdOt.Parameters.Add(new NpgsqlParameter("areas", areasArr) { DataTypeName = "text[]" });
                cmdOt.Parameters.AddWithValue("expand_fs_title", expandFsTitle);
                await using var reader = await cmdOt.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken))
                {
                    var d = DateOnly.FromDateTime(reader.GetDateTime(0));
                    countsByDate[d] = reader.GetInt32(1);
                }
            }

            var jobsOverTime = new List<JobsOverTimePointDto>(capacity: days);
            for (var i = 0; i < days; i++)
            {
                var date = startDate.AddDays(i);
                var count = countsByDate.TryGetValue(date, out var c) ? c : 0;
                jobsOverTime.Add(new JobsOverTimePointDto
                {
                    Date = date.ToString("yyyy-MM-dd"),
                    Count = count
                });
            }

            return new MarketSummaryDto
            {
                Region = profile.DisplayName,
                PeriodDays = days,
                Kpis = new MarketKpisDto
                {
                    TotalJobs = (int)Math.Min(totalJobs, int.MaxValue),
                    RemotePercentage = profile.RemotePercentage,
                    MedianSalary = profile.MedianSalary,
                    HeatScore = profile.HeatScore
                },
                Charts = new MarketChartsDto
                {
                    JobsByField = jobsByField,
                    JobsOverTime = jobsOverTime
                }
            };
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SnapshotDb] summary aggregation failed: {ex.Message}");
            return null;
        }
    }

    public async Task<List<JobListingDto>> GetJobsAsync(
        string region,
        string? location,
        double? centerLat,
        double? centerLng,
        int radiusKm,
        int days,
        IEnumerable<string>? areas,
        IEnumerable<string>? technologies,
        CancellationToken cancellationToken = default)
    {
        var normalizedRegion = NormalizeRegion(region);
        var regionName = RegionProfiles.TryGetValue(normalizedRegion, out var found)
            ? found.DisplayName
            : "Ottawa";
        var effectiveLocation = string.IsNullOrWhiteSpace(location) ? regionName : location.Trim();
        radiusKm = Math.Clamp(radiusKm, 1, 70);
        days = Math.Clamp(days, 1, 90);

        var (areaSet, _, _) = NormalizeAreaFilterForQuery(areas);

        var techSet = (technologies ?? [])
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var dateThreshold = DateTime.UtcNow.Date.AddDays(-(days - 1));

        // Snapshot: única fonte quando JobsSnapshotDb está configurado (evita vagas aleatórias de APIs).
        // Listagens curadas são um dump estático: não filtrar por posted_date aqui (senão sumem vagas
        // com datas antigas no JSON e o UI parece "vazio"). O período (days) continua a aplicar-se ao resumo/charts.
        if (!string.IsNullOrWhiteSpace(_snapshotConnectionString))
        {
            // Não aplicar raio do mapa ao snapshot: com >=5 linhas com lat/lng (pipeline antigo ou mix de fontes),
            // ApplyGeoFilterIfApplicable deixava só as que caíam dentro do círculo (~poucas) e parecia "bug".
            // O dump curado é por área TI; o mapa continua só contexto visual.
            var fromDb = await QueryJobsFromSnapshotAsync(
                dateFrom: null, areaSet, techSet, normalizedRegion, cancellationToken, excludeIds: null, take: 12000);
            if (fromDb.Count == 0)
            {
                return [];
            }

            // Snapshot: id é estável (li-… ou li-…-região); agrupar por título+empresa colapsava vagas distintas.
            return fromDb
                .GroupBy(
                    j => string.IsNullOrWhiteSpace(j.Id) ? $"{j.Title}|{j.Company}|{j.Source}|{j.Url}" : j.Id,
                    StringComparer.OrdinalIgnoreCase)
                .Select(g => g.First())
                .Take(500)
                .ToList();
        }

        // Sem snapshot na config: APIs externas (legado)
        var jobsApi = new List<JobListingDto>();
        jobsApi.AddRange(await FetchAdzunaJobsAsync(effectiveLocation, radiusKm, cancellationToken));
        jobsApi.AddRange(await FetchSerpApiJobsAsync(effectiveLocation, radiusKm, cancellationToken));

        foreach (var job in jobsApi.Where(j => !j.Latitude.HasValue || !j.Longitude.HasValue))
        {
            var resolved = await ResolveCoordinatesAsync(job.Location, cancellationToken);
            if (resolved is null)
            {
                continue;
            }

            job.Latitude ??= resolved.Value.Lat;
            job.Longitude ??= resolved.Value.Lng;
            if (string.Equals(job.GeoPrecision, "none", StringComparison.OrdinalIgnoreCase))
            {
                job.GeoPrecision = resolved.Value.Precision;
            }
        }

        jobsApi = ApplyGeoFilterIfApplicable(jobsApi, centerLat, centerLng, radiusKm);

        var matchesAreaTech = jobsApi.Where(j =>
            (areaSet.Count == 0 || areaSet.Contains(j.Area)) &&
            (techSet.Count == 0 || j.Technologies.Any(t => techSet.Contains(t)) || j.Technologies.Contains("General", StringComparer.OrdinalIgnoreCase)))
            .ToList();

        jobsApi = matchesAreaTech
            .Where(j => ParseDate(j.PostedDate) >= dateThreshold)
            .ToList();

        const int targetMinimumApi = 25;
        if (jobsApi.Count < targetMinimumApi)
        {
            var additional = matchesAreaTech
                .Where(j => jobsApi.All(x => x.Id != j.Id))
                .OrderByDescending(j => ParseDate(j.PostedDate))
                .Take(targetMinimumApi - jobsApi.Count)
                .ToList();
            jobsApi.AddRange(additional);
        }

        if (jobsApi.Count == 0)
        {
            jobsApi = await BuildFallbackJobsAsync(regionName, cancellationToken, areaSet, techSet);
        }

        return jobsApi
            .GroupBy(j => $"{j.Title}|{j.Company}|{j.Source}", StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .Take(500)
            .ToList();
    }

    private static List<JobListingDto> ApplyGeoFilterIfApplicable(
        List<JobListingDto> jobs,
        double? centerLat,
        double? centerLng,
        int radiusKm)
    {
        if (!centerLat.HasValue || !centerLng.HasValue)
        {
            return jobs;
        }

        var jobsWithCoordinates = jobs
            .Where(j => j.Latitude.HasValue && j.Longitude.HasValue)
            .ToList();

        if (jobsWithCoordinates.Count < 5)
        {
            return jobs;
        }

        // Keep rows without coordinates (snapshot import often has no lat/lng); only filter rows that have a point.
        var withoutCoords = jobs
            .Where(j => !j.Latitude.HasValue || !j.Longitude.HasValue)
            .ToList();

        var inside = jobsWithCoordinates
            .Where(j => DistanceKm(centerLat.Value, centerLng.Value, j.Latitude!.Value, j.Longitude!.Value) <= radiusKm)
            .ToList();

        return withoutCoords
            .Concat(inside)
            .OrderByDescending(j => ParseDate(j.PostedDate))
            .ToList();
    }

    private async Task<List<JobListingDto>> QueryJobsFromSnapshotAsync(
        DateTime? dateFrom,
        HashSet<string> areaSet,
        HashSet<string> techSet,
        string normalizedRegion,
        CancellationToken cancellationToken,
        HashSet<string>? excludeIds = null,
        int take = 2000)
    {
        if (string.IsNullOrWhiteSpace(_snapshotConnectionString))
        {
            return [];
        }

        try
        {
            await using var conn = new NpgsqlConnection(_snapshotConnectionString);
            await conn.OpenAsync(cancellationToken);

            var filterAreas = areaSet.Count > 0;
            var expandFsTitle = filterAreas && areaSet.Contains("Full-Stack");
            var filterTechs = techSet.Count > 0;
            var areasArr = filterAreas ? areaSet.ToArray() : Array.Empty<string>();
            var techsArr = filterTechs ? techSet.ToArray() : Array.Empty<string>();
            var excludeArr = excludeIds is { Count: > 0 } ? excludeIds.ToArray() : Array.Empty<string>();
            var regionAnd = BuildSnapshotRegionAndClause(normalizedRegion);
            var chipAnd = BuildSnapshotExcludeHardwareChipAndClause();

            var sql = """
                SELECT id, title, company, location_text, source, url, posted_date, area, technologies, latitude, longitude, geo_precision
                FROM job_snapshot
                WHERE (NOT @filter_areas OR (
                        area = ANY(@areas)
                        OR (@expand_fs_title AND (
                            LOWER(title) LIKE '%full stack%'
                            OR LOWER(title) LIKE '%full-stack%'
                            OR LOWER(title) LIKE '%fullstack%'
                        ))
                    ))
                  AND (NOT @filter_techs
                       OR cardinality(COALESCE(technologies, '{}')) = 0
                       OR EXISTS (
                           SELECT 1 FROM unnest(COALESCE(technologies, '{}')) AS t(v) WHERE lower(t.v) = 'general'
                       )
                       OR EXISTS (
                           SELECT 1
                           FROM unnest(COALESCE(technologies, '{}')) AS t(v)
                           CROSS JOIN unnest(@techs::text[]) AS f(v)
                           WHERE lower(t.v) = lower(f.v)
                       ))
                  AND (@date_from IS NULL OR posted_date >= @date_from::date OR posted_date IS NULL)
                  AND NOT (id = ANY(@exclude_ids))
                """
                + regionAnd
                + chipAnd
                + """
                ORDER BY posted_date DESC NULLS LAST, ingested_at DESC
                LIMIT @take
                """;

            await using var cmd = new NpgsqlCommand(sql, conn);
            cmd.Parameters.AddWithValue("filter_areas", filterAreas);
            cmd.Parameters.AddWithValue("expand_fs_title", expandFsTitle);
            cmd.Parameters.AddWithValue("filter_techs", filterTechs);
            cmd.Parameters.Add(new NpgsqlParameter("areas", areasArr) { DataTypeName = "text[]" });
            cmd.Parameters.Add(new NpgsqlParameter("techs", techsArr) { DataTypeName = "text[]" });
            cmd.Parameters.Add(new NpgsqlParameter("date_from", NpgsqlTypes.NpgsqlDbType.Date)
            {
                Value = dateFrom.HasValue ? dateFrom.Value.Date : DBNull.Value
            });
            cmd.Parameters.Add(new NpgsqlParameter("exclude_ids", excludeArr) { DataTypeName = "text[]" });
            cmd.Parameters.AddWithValue("take", take);

            var jobs = new List<JobListingDto>();
            await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var techs = new List<string>();
                if (!reader.IsDBNull(8))
                {
                    techs = ((string[])reader.GetValue(8)).ToList();
                }

                jobs.Add(new JobListingDto
                {
                    Id = reader.IsDBNull(0) ? "" : reader.GetString(0),
                    Title = reader.IsDBNull(1) ? "" : reader.GetString(1),
                    Company = reader.IsDBNull(2) ? "Unknown company" : reader.GetString(2),
                    Location = reader.IsDBNull(3) ? "Ottawa" : reader.GetString(3),
                    Source = reader.IsDBNull(4) ? "Snapshot" : reader.GetString(4),
                    Url = reader.IsDBNull(5) ? "" : reader.GetString(5),
                    PostedDate = reader.IsDBNull(6) ? DateTime.UtcNow.ToString("yyyy-MM-dd") : reader.GetDateTime(6).ToString("yyyy-MM-dd"),
                    Area = reader.IsDBNull(7) ? "Back-End" : reader.GetString(7),
                    Technologies = techs.Count == 0 ? ["General"] : techs,
                    Latitude = reader.IsDBNull(9) ? null : reader.GetDouble(9),
                    Longitude = reader.IsDBNull(10) ? null : reader.GetDouble(10),
                    GeoPrecision = reader.IsDBNull(11) ? "none" : reader.GetString(11)
                });
            }

            return jobs;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SnapshotDb] query failed: {ex.Message}");
            return [];
        }
    }

    private async Task<List<JobListingDto>> BuildFallbackJobsAsync(
        string regionName,
        CancellationToken cancellationToken,
        HashSet<string> areaSet,
        HashSet<string> techSet)
    {
        var fallback = new List<JobListingDto>();
        fallback.AddRange(await FetchAdzunaJobsAsync(regionName, 30, cancellationToken));
        fallback.AddRange(await FetchSerpApiJobsAsync(regionName, 30, cancellationToken));

        // Passo 1: somente area + tech (sem data)
        var byAreaTech = fallback.Where(j =>
            (areaSet.Count == 0 || areaSet.Contains(j.Area)) &&
            (techSet.Count == 0 || j.Technologies.Any(t => techSet.Contains(t))))
            .ToList();
        if (byAreaTech.Count > 0) return byAreaTech;

        // Passo 2: somente area
        var byArea = fallback.Where(j => areaSet.Count == 0 || areaSet.Contains(j.Area)).ToList();
        if (byArea.Count > 0) return byArea;

        // Passo 3: qualquer vaga recente disponível da região
        return fallback;
    }

    private async Task<ExternalMarketSnapshot?> TryFetchFromAdzunaAsync(string region, int days, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_adzuna.AppId) || string.IsNullOrWhiteSpace(_adzuna.AppKey))
        {
            return null;
        }

        try
        {
            var parsed = new List<AdzunaParsedJob>();
            foreach (var term in AdzunaSearchTerms)
            {
                var endpoint =
                    $"{_adzuna.BaseUrl.TrimEnd('/')}/{_adzuna.Country}/search/1" +
                    $"?app_id={Uri.EscapeDataString(_adzuna.AppId)}" +
                    $"&app_key={Uri.EscapeDataString(_adzuna.AppKey)}" +
                    $"&results_per_page={Math.Clamp(_adzuna.ResultsPerPage, 10, 100)}" +
                    $"&what={Uri.EscapeDataString(term)}" +
                    $"&where={Uri.EscapeDataString(region)}" +
                    "&sort_by=date" +
                    "&content-type=application/json";

                var raw = await GetUtf8PayloadAsync(endpoint, cancellationToken);
                parsed.AddRange(ParseAdzunaJobs(raw, region));
            }

            if (parsed.Count == 0)
            {
                return null;
            }

            var filtered = parsed;
            if (filtered.Count == 0)
            {
                return null;
            }

            var salarySamples = filtered
                .Where(r => r.Salary.HasValue && r.Salary.Value > 0)
                .Select(r => r.Salary!.Value)
                .ToList();

            var inferredFieldCounts = InferFieldDistribution(filtered.Select(x => x.Title).ToList());
            var totalJobs = filtered.Count * Math.Max(1, days / 7);

            return new ExternalMarketSnapshot
            {
                TotalJobs = totalJobs,
                RemotePercentage = InferRemotePercentage(filtered.Select(f => f.Title).ToList(), filtered.Select(f => f.Location).ToList()),
                MedianSalary = salarySamples.Count == 0 ? null : (int?)salarySamples.OrderBy(x => x).ElementAt(salarySamples.Count / 2),
                JobsByField = inferredFieldCounts,
                JobsOverTime = BuildJobsOverTimeFromExternal(days, totalJobs)
            };
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Adzuna-summary] failed: {ex.Message}");
            return null;
        }
    }

    private async Task<List<JobListingDto>> FetchAdzunaJobsAsync(string location, int radiusKm, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_adzuna.AppId) || string.IsNullOrWhiteSpace(_adzuna.AppKey))
        {
            return [];
        }
        var jobs = new List<JobListingDto>();
        var pagesToFetch = 2;
        foreach (var term in AdzunaSearchTerms)
        {
            for (var page = 1; page <= pagesToFetch; page++)
            {
                var endpoint =
                    $"{_adzuna.BaseUrl.TrimEnd('/')}/{_adzuna.Country}/search/{page}" +
                    $"?app_id={Uri.EscapeDataString(_adzuna.AppId)}" +
                    $"&app_key={Uri.EscapeDataString(_adzuna.AppKey)}" +
                    $"&results_per_page={Math.Clamp(_adzuna.ResultsPerPage, 10, 100)}" +
                    $"&what={Uri.EscapeDataString(term)}" +
                    $"&where={Uri.EscapeDataString(location)}" +
                    "&sort_by=date" +
                    "&content-type=application/json";

                try
                {
                    var raw = await GetUtf8PayloadAsync(endpoint, cancellationToken);
                    var parsed = ParseAdzunaJobs(raw, location);
                    jobs.AddRange(parsed.Select(r =>
                        new JobListingDto
                        {
                            Id = $"adzuna-{Math.Abs((r.Title + r.Company + r.PostedDate + term).GetHashCode())}",
                            Title = r.Title,
                            Company = r.Company,
                            Location = r.Location,
                            Area = InferAreaFromTitle(r.Title),
                            Technologies = InferTechnologiesFromTitle(r.Title),
                            Source = "Adzuna",
                            Url = r.Url,
                            PostedDate = r.PostedDate,
                            Latitude = r.Latitude,
                            Longitude = r.Longitude,
                            GeoPrecision = r.Latitude.HasValue && r.Longitude.HasValue ? "exact" : "none"
                        }));
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[Adzuna] term='{term}' page={page} failed: {ex.Message}");
                }
            }
        }

        return jobs;
    }

    private async Task<List<JobListingDto>> FetchSerpApiJobsAsync(string location, int radiusKm, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_serpApi.ApiKey))
        {
            return [];
        }

        // Google Jobs results can include LinkedIn, Job Bank and other job boards links.
        var query = $"software developer OR data engineer OR cybersecurity jobs in {location} within {radiusKm} km";
        var endpoint =
            $"{_serpApi.BaseUrl.TrimEnd('/')}" +
            $"?engine=google_jobs&q={Uri.EscapeDataString(query)}" +
            $"&api_key={Uri.EscapeDataString(_serpApi.ApiKey)}";

        try
        {
            var response = await _httpClient.GetFromJsonAsync<SerpApiResponse>(endpoint, cancellationToken);
            var jobs = response?.JobsResults ?? [];

            var mapped = new List<JobListingDto>();
            foreach (var j in jobs
                         .Where(j => !string.IsNullOrWhiteSpace(j.Title))
                         .Take(Math.Clamp(_serpApi.ResultsLimit, 5, 100)))
            {
                var title = j.Title ?? "Unknown role";
                var url = j.RelatedLinks?.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x.Link))?.Link ?? "";
                var resolved = await ResolveCoordinatesAsync(j.Location ?? location, cancellationToken);
                mapped.Add(new JobListingDto
                {
                    Id = $"serp-{Math.Abs((title + (j.CompanyName ?? "")).GetHashCode())}",
                    Title = title,
                    Company = j.CompanyName ?? "Unknown company",
                    Location = j.Location ?? location,
                    Area = InferAreaFromTitle(title),
                    Technologies = InferTechnologiesFromTitle(title),
                    Source = DetectSourceFromLink(url),
                    Url = url,
                    PostedDate = NormalizePostedDate(j.DetectedExtensions?.PostedAt),
                    Latitude = resolved?.Lat,
                    Longitude = resolved?.Lng,
                    GeoPrecision = resolved?.Precision ?? "none"
                });
            }

            return mapped;
        }
        catch
        {
            return [];
        }
    }

    private static string NormalizeRegion(string? region)
    {
        var key = (region ?? "ottawa").Trim().ToLowerInvariant();
        if (RegionAliases.TryGetValue(key, out var aliasResolved))
        {
            return aliasResolved;
        }

        return key;
    }

    private static List<JobsByFieldPointDto> BuildJobsByField(RegionProfile profile, int totalJobs)
    {
        var points = profile.FieldDistribution
            .Select(pair => new JobsByFieldPointDto
            {
                Field = pair.Key,
                Count = (int)Math.Round(totalJobs * pair.Value)
            })
            .OrderByDescending(x => x.Count)
            .ToList();

        var diff = totalJobs - points.Sum(x => x.Count);
        if (points.Count > 0 && diff != 0)
        {
            points[0].Count += diff;
        }

        return points;
    }

    private static List<JobsOverTimePointDto> BuildJobsOverTime(RegionProfile profile, int days, int totalJobs)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var startDate = today.AddDays(-(days - 1));
        var avgDaily = Math.Max(1, totalJobs / days);
        var weekdayBias = profile.HeatScore / 100.0;

        var series = new List<JobsOverTimePointDto>(capacity: days);
        var assigned = 0;
        for (var i = 0; i < days; i++)
        {
            var date = startDate.AddDays(i);
            var weekdayMultiplier = date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday ? 0.70 : 1.12;
            var wave = 1 + 0.10 * Math.Sin(i / 3.0);
            var count = (int)Math.Round(avgDaily * weekdayMultiplier * wave * weekdayBias);
            count = Math.Max(1, count);
            assigned += count;

            series.Add(new JobsOverTimePointDto
            {
                Date = date.ToString("yyyy-MM-dd"),
                Count = count
            });
        }

        // Ajuste para a série fechar no total agregado.
        var delta = totalJobs - assigned;
        if (series.Count > 0 && delta != 0)
        {
            series[^1].Count = Math.Max(1, series[^1].Count + delta);
        }

        return series;
    }

    private static List<JobsByFieldPointDto> InferFieldDistribution(List<string> jobTitles)
    {
        var buckets = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        {
            ["Data/AI"] = 0,
            ["Cybersecurity"] = 0,
            ["Cloud/DevOps"] = 0,
            ["Full-Stack"] = 0,
            ["QA"] = 0
        };

        foreach (var title in jobTitles)
        {
            var t = title.ToLowerInvariant();
            if (t.Contains("data") || t.Contains("machine learning") || t.Contains("ai"))
            {
                buckets["Data/AI"]++;
            }
            else if (t.Contains("security") || t.Contains("cyber"))
            {
                buckets["Cybersecurity"]++;
            }
            else if (t.Contains("devops") || t.Contains("cloud") || t.Contains("platform") || t.Contains("sre"))
            {
                buckets["Cloud/DevOps"]++;
            }
            else if (t.Contains("qa") || t.Contains("test") || t.Contains("quality"))
            {
                buckets["QA"]++;
            }
            else
            {
                buckets["Full-Stack"]++;
            }
        }

        return buckets
            .Where(x => x.Value > 0)
            .Select(x => new JobsByFieldPointDto { Field = x.Key, Count = x.Value })
            .OrderByDescending(x => x.Count)
            .ToList();
    }

    private static string InferAreaFromTitle(string title)
    {
        var t = title.ToLowerInvariant();
        if (t.Contains("security") || t.Contains("cyber")) return "Cybersecurity";
        // Full-Stack before Front-End: titles often include React/Angular only in the role name.
        if (t.Contains("full stack") || t.Contains("full-stack") || t.Contains("fullstack")) return "Full-Stack";
        if (t.Contains("data") || t.Contains("ml") || t.Contains("ai")) return "Data";
        if (t.Contains("qa") || t.Contains("quality") || t.Contains("test")) return "Quality Assurance";
        if (t.Contains("devops") || t.Contains("cloud") || t.Contains("sre")) return "Cloud";
        if (t.Contains("front") || t.Contains("ui") || t.Contains("react") || t.Contains("angular")) return "Front-End";
        return "Back-End";
    }

    private static List<string> InferTechnologiesFromTitle(string title)
    {
        var techMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["react"] = "React",
            ["angular"] = "Angular",
            ["vue"] = "Vue",
            ["typescript"] = "TypeScript",
            ["javascript"] = "JavaScript",
            ["node"] = "Node.js",
            [".net"] = ".NET",
            ["c#"] = "C#",
            ["python"] = "Python",
            ["java"] = "Java",
            ["sql"] = "SQL",
            ["azure"] = "Azure",
            ["aws"] = "AWS",
            ["gcp"] = "GCP",
            ["kubernetes"] = "Kubernetes",
            ["docker"] = "Docker",
            ["terraform"] = "Terraform",
            ["cypress"] = "Cypress",
            ["playwright"] = "Playwright"
        };

        var lower = title.ToLowerInvariant();
        var found = techMap
            .Where(pair => lower.Contains(pair.Key.ToLowerInvariant()))
            .Select(pair => pair.Value)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(6)
            .ToList();

        if (found.Count == 0)
        {
            found.Add("General");
        }

        return found;
    }

    private static string DetectSourceFromLink(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return "Google Jobs";
        var lower = url.ToLowerInvariant();
        if (lower.Contains("linkedin.")) return "LinkedIn";
        if (lower.Contains("jobbank.gc.ca")) return "Job Bank";
        if (lower.Contains("indeed.")) return "Indeed";
        if (lower.Contains("monster.")) return "Monster";
        return "Google Jobs";
    }

    private static string NormalizePostedDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return DateTime.UtcNow.ToString("yyyy-MM-dd");
        }

        if (DateTime.TryParse(value, out var parsed))
        {
            return parsed.ToUniversalTime().ToString("yyyy-MM-dd");
        }

        return DateTime.UtcNow.ToString("yyyy-MM-dd");
    }

    private static DateTime ParseDate(string value)
    {
        if (DateTime.TryParse(value, out var parsed))
        {
            return parsed.Date;
        }
        return DateTime.UtcNow.Date;
    }

    private static int InferRemotePercentage(List<string> titles, List<string> locations)
    {
        var total = Math.Max(1, Math.Min(titles.Count, locations.Count));
        var remoteHits = 0;
        for (var i = 0; i < total; i++)
        {
            if (titles[i].Contains("remote", StringComparison.OrdinalIgnoreCase) ||
                locations[i].Contains("remote", StringComparison.OrdinalIgnoreCase))
            {
                remoteHits++;
            }
        }
        return (int)Math.Round((double)remoteHits / total * 100);
    }

    private static List<AdzunaParsedJob> ParseAdzunaJobs(string rawJson, string fallbackLocation)
    {
        using var doc = JsonDocument.Parse(rawJson);
        if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var jobs = new List<AdzunaParsedJob>();
        foreach (var item in results.EnumerateArray())
        {
            var title = item.TryGetProperty("title", out var titleEl) ? titleEl.GetString() : null;
            if (string.IsNullOrWhiteSpace(title)) continue;

            string company = "Unknown company";
            if (item.TryGetProperty("company", out var companyEl) &&
                companyEl.ValueKind == JsonValueKind.Object &&
                companyEl.TryGetProperty("display_name", out var companyNameEl))
            {
                company = companyNameEl.GetString() ?? company;
            }

            string location = fallbackLocation;
            if (item.TryGetProperty("location", out var locationEl) &&
                locationEl.ValueKind == JsonValueKind.Object &&
                locationEl.TryGetProperty("display_name", out var locationNameEl))
            {
                location = locationNameEl.GetString() ?? location;
            }

            int? salary = null;
            if (item.TryGetProperty("salary_min", out var minEl) && minEl.TryGetInt32(out var minValue))
            {
                salary = minValue;
            }
            else if (item.TryGetProperty("salary_max", out var maxEl) && maxEl.TryGetInt32(out var maxValue))
            {
                salary = maxValue;
            }

            var created = item.TryGetProperty("created", out var createdEl) ? createdEl.GetString() : null;
            var url = item.TryGetProperty("redirect_url", out var urlEl) ? urlEl.GetString() ?? "" : "";
            double? latitude = null;
            double? longitude = null;
            if (item.TryGetProperty("latitude", out var latEl) && latEl.TryGetDouble(out var lat))
            {
                latitude = lat;
            }
            if (item.TryGetProperty("longitude", out var lngEl) && lngEl.TryGetDouble(out var lng))
            {
                longitude = lng;
            }

            jobs.Add(new AdzunaParsedJob
            {
                Title = title,
                Company = company,
                Location = location,
                Salary = salary,
                PostedDate = NormalizePostedDate(created),
                Url = url,
                Latitude = latitude,
                Longitude = longitude
            });
        }

        return jobs;
    }

    private async Task<string> GetUtf8PayloadAsync(string url, CancellationToken cancellationToken)
    {
        var bytes = await _httpClient.GetByteArrayAsync(url, cancellationToken);
        return Encoding.UTF8.GetString(bytes);
    }

    private async Task<(double Lat, double Lng, string Precision)?> ResolveCoordinatesAsync(string? rawLocation, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(rawLocation))
        {
            return null;
        }

        var normalized = rawLocation.Trim().ToLowerInvariant();
        if (LocationGeoCache.TryGetValue(normalized, out var cached))
        {
            return cached;
        }

        foreach (var known in KnownLocationCoordinates)
        {
            if (normalized.Contains(known.Key, StringComparison.OrdinalIgnoreCase))
            {
                LocationGeoCache[normalized] = known.Value;
                return known.Value;
            }
        }

        try
        {
            var url =
                $"https://nominatim.openstreetmap.org/search?q={Uri.EscapeDataString(rawLocation + ", Ontario, Canada")}&format=json&limit=1";
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("User-Agent", "ITrack/1.0 (job-market-dashboard)");
            using var response = await _httpClient.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            var payload = await response.Content.ReadAsStringAsync(cancellationToken);
            using var doc = JsonDocument.Parse(payload);
            if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() == 0)
            {
                return null;
            }

            var first = doc.RootElement[0];
            if (!first.TryGetProperty("lat", out var latEl) || !first.TryGetProperty("lon", out var lonEl))
            {
                return null;
            }

            if (!double.TryParse(latEl.GetString(), out var lat) || !double.TryParse(lonEl.GetString(), out var lng))
            {
                return null;
            }

            var resolved = (Lat: lat, Lng: lng, Precision: "estimated");
            LocationGeoCache[normalized] = resolved;
            return resolved;
        }
        catch
        {
            return null;
        }
    }

    private static double DistanceKm(double lat1, double lon1, double lat2, double lon2)
    {
        double ToRad(double deg) => deg * (Math.PI / 180);
        var dLat = ToRad(lat2 - lat1);
        var dLon = ToRad(lon2 - lon1);
        var a =
            Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
            Math.Cos(ToRad(lat1)) * Math.Cos(ToRad(lat2)) *
            Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        var c = 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));
        return 6371 * c;
    }

    private static List<JobsOverTimePointDto> BuildJobsOverTimeFromExternal(int days, int totalJobs)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var start = today.AddDays(-(days - 1));
        var perDay = Math.Max(1, totalJobs / days);
        var series = new List<JobsOverTimePointDto>(days);

        for (var i = 0; i < days; i++)
        {
            var date = start.AddDays(i);
            var weight = date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday ? 0.8 : 1.1;
            series.Add(new JobsOverTimePointDto
            {
                Date = date.ToString("yyyy-MM-dd"),
                Count = Math.Max(1, (int)Math.Round(perDay * weight))
            });
        }

        return series;
    }

    private sealed record RegionProfile(
        string DisplayName,
        int BaseTotalJobs,
        int RemotePercentage,
        int MedianSalary,
        int HeatScore,
        Dictionary<string, double> FieldDistribution
    );

    private sealed class ExternalMarketSnapshot
    {
        public int TotalJobs { get; set; }
        public int? RemotePercentage { get; set; }
        public int? MedianSalary { get; set; }
        public List<JobsByFieldPointDto>? JobsByField { get; set; }
        public List<JobsOverTimePointDto>? JobsOverTime { get; set; }
    }

    private sealed class AdzunaParsedJob
    {
        public string Title { get; set; } = "";
        public string Company { get; set; } = "";
        public string Location { get; set; } = "";
        public int? Salary { get; set; }
        public string PostedDate { get; set; } = "";
        public string Url { get; set; } = "";
        public double? Latitude { get; set; }
        public double? Longitude { get; set; }
    }
}